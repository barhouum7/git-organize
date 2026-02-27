import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import pc from "picocolors";
import {
  getRepoRoot,
  getAllFileTimestamps,
  getAllDiffStats,
  getAllExportDeltas,
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

export interface TimeStats {
  earliest: number;
  latest: number;
  spanSeconds: number;
  spanLabel: string;
  lastModifiedLabel: string;
  lastModifiedFile: string;
}

export interface ChangeGroup {
  id: number;
  label: string;
  files: string[];
  suggestedBranch: string;
  confidence: number;
  diffSummary: ClusterDiffSummary;
  timeStats?: TimeStats;
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
  featureKey: string;
  timestamp: number;
}

const LARGE_CLUSTER_THRESHOLD = 15;
const TIME_GAP_SECONDS = 45 * 60; // 45 minutes

const PATH_STOP_WORDS = new Set([
  "src",
  "app",
  "pages",
  "components",
  "component",
  "routes",
  "route",
  "lib",
  "utils",
  "common",
  "index",
  "page",
  "layout",
  "layouts",
  "api",
  "types",
  "hooks",
  "store",
  "stores",
  "config",
  "_components",
  "(root)",
  "(routes)",
  "(main)",
  "(dashboard)",
  "(auth)",
]);

function formatTimeSpan(earliest: number, latest: number): { spanLabel: string; lastModifiedLabel: string } {
  const now = Math.floor(Date.now() / 1000);
  const spanSeconds = Math.max(0, latest - earliest);
  const ago = now - latest;

  let spanLabel: string;
  if (spanSeconds < 60) spanLabel = "< 1m";
  else if (spanSeconds < 3600) spanLabel = `${Math.round(spanSeconds / 60)}m`;
  else if (spanSeconds < 86400) spanLabel = `${(spanSeconds / 3600).toFixed(1)}h`;
  else spanLabel = `${Math.round(spanSeconds / 86400)}d`;

  let lastModifiedLabel: string;
  if (ago < 60) lastModifiedLabel = "just now";
  else if (ago < 3600) lastModifiedLabel = `${Math.round(ago / 60)}m ago`;
  else if (ago < 86400) lastModifiedLabel = `${Math.round(ago / 3600)}h ago`;
  else lastModifiedLabel = `${Math.round(ago / 86400)}d ago`;

  return { spanLabel, lastModifiedLabel };
}

function extractFeatureKey(filePath: string): string {
  const withoutExt = filePath.replace(/\.[^./\\]+$/, "");
  const segments = withoutExt.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return "";

  // Prefer a directory-level feature key (parent folders) over file name.
  for (let i = segments.length - 2; i >= 0; i--) {
    const raw = segments[i]!;
    const seg = raw.toLowerCase();
    if (!seg) continue;
    if (PATH_STOP_WORDS.has(seg)) continue;
    if (seg.startsWith("[") && seg.endsWith("]")) continue;
    if (seg.startsWith("(") && seg.endsWith(")")) continue;
    if (seg === "_components") continue;
    return seg;
  }

  // Fallback to the file name segment if no good parent directory is found.
  const lastRaw = segments[segments.length - 1]!;
  const last = lastRaw.toLowerCase();
  if (!last) return "";
  if (PATH_STOP_WORDS.has(last)) return "";
  if (last.startsWith("[") && last.endsWith("]")) return "";
  if (last.startsWith("(") && last.endsWith(")")) return "";
  if (last === "_components") return "";
  return last;
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

function buildFileInfo(
  files: string[],
  repoRoot: string,
  timestampMap: Map<string, number>,
): FileInfo[] {
  const now = Math.floor(Date.now() / 1000);
  return files.map((relativePath) => {
    const dir = path.dirname(relativePath);
    const absolutePath = path.join(repoRoot, relativePath);
    return {
      path: relativePath,
      dir,
      importTokens: parseImportTokens(absolutePath),
      featureKey: extractFeatureKey(relativePath),
      timestamp: timestampMap.get(relativePath) ?? now,
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

function buildBranchSlugFromFiles(label: string, files: string[]): string | null {
  const isMixed = label === "(mixed)" || label.startsWith("(mixed:");

  const tokenCounts = new Map<string, number>();
  for (const file of files) {
    const withoutExt = file.replace(/\.[^./\\]+$/, "");
    const segments = withoutExt.split(/[\\/]+/).filter(Boolean);
    for (const segRaw of segments) {
      const seg = segRaw.toLowerCase();
      if (!seg) continue;
      if (PATH_STOP_WORDS.has(seg)) continue;
      if (seg.startsWith("[") && seg.endsWith("]")) continue;
      if (seg.startsWith("(") && seg.endsWith(")")) continue;
      if (/^[0-9]+$/.test(seg)) continue;
      tokenCounts.set(seg, (tokenCounts.get(seg) ?? 0) + 1);
    }
  }

  const tokens = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);

  if (tokens.length === 0) {
    return null;
  }

  if (isMixed) {
    const slug = tokens.slice(0, 2).join("-");
    return `feature/${slug}`;
  }

  const slug = tokens[0]!;
  return `feature/${slug}`;
}

function suggestBranchName(label: string, files: string[]): string {
  if (label === "(repo root)") {
    return "chore/root-changes";
  }

  if (label === "(mixed)" || label.startsWith("(mixed:")) {
    const fromFiles = buildBranchSlugFromFiles(label, files);
    if (fromFiles) return fromFiles;
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
  const stagedOnly = options.stagedOnly ?? false;

  const [timestampMap, diffStatsMap, exportDeltasMap] = (() => {
    const ts = getAllFileTimestamps(repoRoot, files);
    const diff = getAllDiffStats(repoRoot, files, stagedOnly);
    const exp = getAllExportDeltas(repoRoot, files, stagedOnly);
    return [ts, diff, exp] as const;
  })();

  const info = buildFileInfo(files, repoRoot, timestampMap);
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

  const refineComponent = (
    componentIndices: number[],
    originalLabel: string,
  ): number[][] => {
    if (componentIndices.length <= LARGE_CLUSTER_THRESHOLD) {
      return [componentIndices];
    }

    const isMixedLabel =
      originalLabel === "(mixed)" || originalLabel.startsWith("(mixed:");
    if (!isMixedLabel) {
      return [componentIndices];
    }

    const byFeature = new Map<string, number[]>();
    for (const index of componentIndices) {
      const key = info[index]!.featureKey || "(other)";
      const arr = byFeature.get(key);
      if (arr) {
        arr.push(index);
      } else {
        byFeature.set(key, [index]);
      }
    }

    if (byFeature.size <= 1) {
      return [componentIndices];
    }

    const subcomponents: number[][] = [];

    for (const [, list] of byFeature.entries()) {
      if (list.length === 0) continue;

      // Small feature buckets: keep as is.
      if (list.length <= 3 || list.length <= LARGE_CLUSTER_THRESHOLD) {
        subcomponents.push(list);
        continue;
      }

      // Very large feature bucket: optionally split by time gaps.
      const sorted = [...list].sort(
        (a, b) => info[a]!.timestamp - info[b]!.timestamp,
      );

      let currentBucket: number[] = [sorted[0]!];
      for (let k = 1; k < sorted.length; k++) {
        const prev = sorted[k - 1]!;
        const curr = sorted[k]!;
        const delta =
          Math.abs(info[curr]!.timestamp - info[prev]!.timestamp) ?? 0;
        if (delta > TIME_GAP_SECONDS && currentBucket.length >= 2) {
          subcomponents.push(currentBucket);
          currentBucket = [curr];
        } else {
          currentBucket.push(curr);
        }
      }
      if (currentBucket.length > 0) {
        subcomponents.push(currentBucket);
      }
    }

    if (subcomponents.length === 0) {
      return [componentIndices];
    }

    if (subcomponents.length === 1) {
      return [componentIndices];
    }

    return subcomponents;
  };

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

    const baseDirs = componentIndices.map((index) => info[index]!.dir);
    const originalLabel = longestCommonDirPrefix(baseDirs);
    const refinedComponents = refineComponent(componentIndices, originalLabel);

    for (const indices of refinedComponents) {
      const componentFiles = indices
        .map((index) => info[index]!.path)
        .sort();
      const dirs = indices.map((index) => info[index]!.dir);
      const label = longestCommonDirPrefix(dirs);
      const suggestedBranch = suggestBranchName(label, componentFiles);
      const confidence = computeConfidence(info, indices, adjacency);

      let added = 0;
      let removed = 0;
      const newExportsSet = new Set<string>();
      const modifiedExportsSet = new Set<string>();

      for (const file of componentFiles) {
        const stats = diffStatsMap.get(file) ?? { added: 0, removed: 0 };
        added += stats.added;
        removed += stats.removed;
        const delta = exportDeltasMap.get(file) ?? { newExports: [], modifiedExports: [] };
        delta.newExports.forEach((e) => newExportsSet.add(e));
        delta.modifiedExports.forEach((e) => modifiedExportsSet.add(e));
      }

      const timestamps = indices.map((idx) => info[idx]!.timestamp);
      const earliest = Math.min(...timestamps);
      const latest = Math.max(...timestamps);
      const { spanLabel, lastModifiedLabel } = formatTimeSpan(earliest, latest);
      // Pick the file whose timestamp equals `latest` — no extra git calls needed.
      const lastModifiedFile =
        indices
          .map((idx) => info[idx]!)
          .sort((a, b) => b.timestamp - a.timestamp)[0]?.path ?? "N/A";
      const timeStats: TimeStats = {
        earliest,
        latest,
        spanSeconds: Math.max(0, latest - earliest),
        spanLabel,
        lastModifiedLabel,
        lastModifiedFile,
      };

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
        timeStats,
      });
    }
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
  parts.push(`${pc.green(`+${d.added}`)} ${pc.red(`-${d.removed}`)}`);
  if (d.newExports.length > 0) {
    parts.push(`${pc.magentaBright(`New exports:`)} ${d.newExports.join(", ")}`);
  }
  if (d.modifiedExports.length > 0) {
    parts.push(`${pc.magentaBright(`Modified exports:`)} ${d.modifiedExports.join(", ")}`);
  }
  return parts.join(" | ");
}

export function printAnalysisResult(result: AnalysisResult): void {
  const { groups } = result;
  console.log(pc.bold(pc.cyan(`Detected ${groups.length} logical group(s):`)));
  console.log("");
  for (const group of groups) {
    // displayFile is already computed in buildGroups — no extra git calls needed here.
    const rawFile = group.timeStats?.lastModifiedFile ?? null;
    // Check if the file path is too long to display, and if so, shorten it like (very/long/path/to/file.js -> .../to/file.js) to avoid overwhelming the user with too much text.
    const displayFile = rawFile && rawFile.length > 40
      ? `.../${rawFile.slice(-37)}`
      : rawFile ?? "N/A";
    // Confidence coloring: green >= 80%, yellow >= 60%, red otherwise.
    const confidenceText = `${(group.confidence * 100).toFixed(0)}%`;
    const confidenceColored =
      group.confidence >= 0.8
        ? pc.green(confidenceText)
        : group.confidence >= 0.6
          ? pc.yellow(confidenceText)
          : pc.red(confidenceText);

    console.log(
      `${pc.bold(
        pc.white(`[${group.id}]`),
      )} ${pc.bold(pc.cyan(group.label))} (${group.files.length} file(s)) — ${pc.blueBright(`Confidence:`)} ${confidenceColored}`,
    );
    for (const file of group.files) {
      console.log(`  ${pc.dim("-")} ${file}`);
    }
    console.log(
      `  ${pc.magentaBright("Suggested branch:")} ${pc.bold(
        pc.green(group.suggestedBranch),
      )}`,
    );
    console.log(`  ${pc.magentaBright("Diff:")} ${formatDiffSummary(group)}`);
    if (group.timeStats) {
      console.log(
        `  ${pc.magentaBright("Time:")} span ${pc.cyan(group.timeStats.spanLabel)} | last ${pc.cyan(group.timeStats.lastModifiedLabel)}
        File: ${pc.yellow(displayFile)} (${new Date(group.timeStats.latest * 1000).toLocaleString()})
        `,
      );
    }
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
