import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
  getRepoRoot,
  getDiffStats,
  getExportDelta,
  type FileDiffStats,
  type ExportDelta,
} from "./diff-summary";

export interface AnalyzeOptions {
  stagedOnly?: boolean;
  repoRoot?: string;
}

export interface ClusterDiffSummary {
  added: number;
  removed: number;
  newExports: string[];
  modifiedExports: string[];
}

export interface ChangeGroup {
  id: number;
  label: string;
  files: string[];
  suggestedBranch: string;
  confidence: number;
  diffSummary: ClusterDiffSummary;
}

export interface AnalysisResult {
  groups: ChangeGroup[];
  totalFiles: number;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function getChangedFiles(options: AnalyzeOptions): string[] {
  const { stagedOnly } = options;

  try {
    if (stagedOnly) {
      const output = execSync("git diff --name-only --cached", {
        encoding: "utf8",
      });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }

    const diffOutput = execSync("git diff --name-only", {
      encoding: "utf8",
    });

    const diffFiles = diffOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const untrackedOutput = execSync(
      "git ls-files --others --exclude-standard",
      {
        encoding: "utf8",
      },
    );

    const untrackedFiles = untrackedOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const allFiles = unique([...diffFiles, ...untrackedFiles]);

    const noisyDirs = [
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      ".turbo/",
      "coverage/",
    ];

    return allFiles.filter((file) => {
      if (!file) return false;
      for (const noisy of noisyDirs) {
        if (file.startsWith(noisy)) {
          return false;
        }
      }
      return true;
    });
  } catch {
    throw new Error(
      "Failed to read git changes. Are you running inside a git repository?",
    );
  }
}

interface FileInfo {
  path: string;
  dir: string;
  importTokens: Set<string>;
}

function parseImportTokens(filePath: string): Set<string> {
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  if (!exts.some((ext) => filePath.endsWith(ext))) {
    return new Set();
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const tokens = new Set<string>();

    const importRegex =
      /import\s+[^'"]*from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content))) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;

      const cleaned = specifier.replace(/^[@./]+/, "");
      const parts = cleaned.split(/[\\/]/);
      const last = parts[parts.length - 1];
      if (last) {
        tokens.add(last.toLowerCase());
      }
    }

    return tokens;
  } catch {
    return new Set();
  }
}

function buildFileInfo(files: string[], repoRoot: string): FileInfo[] {
  return files.map((relativePath) => {
    const dir = path.dirname(relativePath);
    const absolutePath = path.join(repoRoot, relativePath);
    return {
      path: relativePath,
      dir,
      importTokens: parseImportTokens(absolutePath),
    };
  });
}

function longestCommonDirPrefix(dirs: string[]): string {
  if (dirs.length === 0) return "(mixed)";
  const segmentsList = dirs.map((d) =>
    d === "." ? [] : d.split(/[\\/]+/).filter(Boolean),
  );

  const first = segmentsList[0] ?? [];
  const prefix: string[] = [];

  for (let i = 0; i < first.length; i++) {
    const segment = first[i]!;
    if (segmentsList.every((segments) => segments[i] === segment)) {
      prefix.push(segment);
    } else {
      break;
    }
  }

  if (prefix.length === 0) {
    const firstSegments = new Set(
      segmentsList.map((segments) => segments[0]).filter(Boolean),
    );
    const list = Array.from(firstSegments).sort().join(", ");
    return list ? `(mixed: ${list})` : "(mixed)";
  }

  return prefix.join("/");
}

function suggestBranchName(label: string): string {
  if (label === "(repo root)") {
    return "chore/root-changes";
  }

  if (label === "(mixed)" || label.startsWith("(mixed:")) {
    return "feature/mixed-changes";
  }

  const sanitized = label
    .replace(/^[./]+/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  if (!sanitized) {
    return "feature/changes";
  }

  return `feature/${sanitized}`;
}

function computeConfidence(
  info: FileInfo[],
  componentIndices: number[],
  adjacency: number[][],
): number {
  const n = componentIndices.length;
  if (n === 0) return 0;
  if (n === 1) return 0.6;

  let sameDirPairs = 0;
  let importPairs = 0;
  const maxPairs = (n * (n - 1)) / 2;

  for (let i = 0; i < componentIndices.length; i++) {
    for (let j = i + 1; j < componentIndices.length; j++) {
      const a = info[componentIndices[i]!]!;
      const b = info[componentIndices[j]!]!;
      if (a.dir === b.dir) sameDirPairs++;
      const idxI = componentIndices[i]!;
      const idxJ = componentIndices[j]!;
      if (adjacency[idxI]!.includes(idxJ)) importPairs++;
    }
  }

  const sameDirScore = maxPairs > 0 ? sameDirPairs / maxPairs : 0;
  const linkScore = maxPairs > 0 ? importPairs / maxPairs : 0;
  const coherence = 0.5 * sameDirScore + 0.5 * Math.min(1, linkScore * 2);
  return Math.round((0.5 + 0.5 * coherence) * 100) / 100;
}

function buildGroups(
  files: string[],
  options: AnalyzeOptions,
): ChangeGroup[] {
  if (files.length === 0) {
    return [];
  }

  const repoRoot = options.repoRoot ?? getRepoRoot();
  const info = buildFileInfo(files, repoRoot);
  const n = info.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);

  const shareDir = (a: FileInfo, b: FileInfo): boolean => a.dir === b.dir;

  const shareImports = (a: FileInfo, b: FileInfo): boolean => {
    if (a.importTokens.size === 0 || b.importTokens.size === 0) {
      return false;
    }
    for (const token of a.importTokens) {
      if (b.importTokens.has(token)) {
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = info[i]!;
      const b = info[j]!;
      if (shareDir(a, b) || shareImports(a, b)) {
        adjacency[i]!.push(j);
        adjacency[j]!.push(i);
      }
    }
  }

  const visited = new Array<boolean>(n).fill(false);
  const groups: ChangeGroup[] = [];
  let groupId = 1;
  const stagedOnly = options.stagedOnly ?? false;

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const stack = [i];
    const componentIndices: number[] = [];
    visited[i] = true;

    while (stack.length > 0) {
      const current = stack.pop()!;
      componentIndices.push(current);
      for (const neighbor of adjacency[current]!) {
        if (!visited[neighbor]) {
          visited[neighbor] = true;
          stack.push(neighbor);
        }
      }
    }

    const componentFiles = componentIndices
      .map((index) => info[index]!.path)
      .sort();
    const dirs = componentIndices.map((index) => info[index]!.dir);
    const label = longestCommonDirPrefix(dirs);
    const suggestedBranch = suggestBranchName(label);
    const confidence = computeConfidence(info, componentIndices, adjacency);

    let added = 0;
    let removed = 0;
    const newExportsSet = new Set<string>();
    const modifiedExportsSet = new Set<string>();

    for (const file of componentFiles) {
      const stats = getDiffStats(repoRoot, file, stagedOnly);
      added += stats.added;
      removed += stats.removed;
      const delta = getExportDelta(repoRoot, file, stagedOnly);
      delta.newExports.forEach((e) => newExportsSet.add(e));
      delta.modifiedExports.forEach((e) => modifiedExportsSet.add(e));
    }

    groups.push({
      id: groupId++,
      label,
      files: componentFiles,
      suggestedBranch,
      confidence,
      diffSummary: {
        added,
        removed,
        newExports: Array.from(newExportsSet).sort(),
        modifiedExports: Array.from(modifiedExportsSet).sort(),
      },
    });
  }

  return groups;
}

export function runAnalysisSync(options: AnalyzeOptions): AnalysisResult | null {
  const files = getChangedFiles(options);

  if (files.length === 0) {
    return null;
  }

  const groups = buildGroups(files, options);
  return { groups, totalFiles: files.length };
}

function formatDiffSummary(g: ChangeGroup): string {
  const d = g.diffSummary;
  const parts: string[] = [];
  parts.push(`+${d.added} -${d.removed}`);
  if (d.newExports.length > 0) {
    parts.push(`New exports: ${d.newExports.join(", ")}`);
  }
  if (d.modifiedExports.length > 0) {
    parts.push(`Modified exports: ${d.modifiedExports.join(", ")}`);
  }
  return parts.join(" | ");
}

export function printAnalysisResult(result: AnalysisResult): void {
  const { groups } = result;
  console.log(`Detected ${groups.length} logical group(s):\n`);
  for (const group of groups) {
    console.log(
      `[${group.id}] ${group.label} (${group.files.length} file(s)) — Confidence: ${(group.confidence * 100).toFixed(0)}%`,
    );
    for (const file of group.files) {
      console.log(`  - ${file}`);
    }
    console.log(`  Suggested branch: ${group.suggestedBranch}`);
    console.log(`  Diff: ${formatDiffSummary(group)}`);
    console.log("");
  }
}

export function runAnalysis(options: AnalyzeOptions): void {
  const result = runAnalysisSync(options);
  if (!result) {
    console.log("No changes detected in the working tree.");
    return;
  }
  printAnalysisResult(result);
}
