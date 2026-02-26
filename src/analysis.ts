import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface AnalyzeOptions {
  stagedOnly?: boolean;
}

interface ChangeGroup {
  id: number;
  label: string;
  files: string[];
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
  } catch (error) {
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

function buildFileInfo(files: string[]): FileInfo[] {
  return files.map((relativePath) => {
    const dir = path.dirname(relativePath);
    const absolutePath = path.resolve(relativePath);
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
    return "(mixed)";
  }

  return prefix.join("/");
}

function buildGroups(files: string[]): ChangeGroup[] {
  if (files.length === 0) {
    return [];
  }

  const info = buildFileInfo(files);
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

    groups.push({
      id: groupId++,
      label,
      files: componentFiles,
    });
  }

  return groups;
}

function suggestBranchName(label: string): string {
  if (label === "(repo root)") {
    return "chore/root-changes";
  }

  if (label === "(mixed)") {
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

export function runAnalysis(options: AnalyzeOptions): void {
  const files = getChangedFiles(options);

  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No changes detected in the working tree.");
    return;
  }

  const groups = buildGroups(files);

  // eslint-disable-next-line no-console
  console.log(`Detected ${groups.length} logical group(s):\n`);

  for (const group of groups) {
    const branchName = suggestBranchName(group.label);

    // eslint-disable-next-line no-console
    console.log(
      `[${group.id}] ${group.label} (${group.files.length} file(s))`,
    );
    for (const file of group.files) {
      // eslint-disable-next-line no-console
      console.log(`  - ${file}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n  Suggested branch: ${branchName}\n`);
  }
}

