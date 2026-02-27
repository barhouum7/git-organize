import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface FileDiffStats {
  added: number;
  removed: number;
}

export interface ExportDelta {
  newExports: string[];
  modifiedExports: string[];
}

const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+const\s+(\w+)/g,
  /export\s+class\s+(\w+)/g,
  /export\s+interface\s+(\w+)/g,
  /export\s+type\s+(\w+)\s*[=<>]/g,
  /export\s+\{\s*([^}]+)\}/g,
];

function extractExportNamesFromLine(line: string): string[] {
  const names: string[] = [];
  for (const re of EXPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const raw = m[1];
      if (raw) {
        raw.split(",").forEach((s) => {
          const name = s.replace(/^\s*(\w+).*$/, "$1").trim();
          if (name) names.push(name);
        });
      }
    }
  }
  return names;
}

function isTracked(repoRoot: string, filePath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- "${filePath}"`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function getDiffStats(
  repoRoot: string,
  filePath: string,
  stagedOnly: boolean,
): FileDiffStats {
  const fullPath = path.join(repoRoot, filePath);
  if (!isTracked(repoRoot, filePath)) {
    if (!fs.existsSync(fullPath)) return { added: 0, removed: 0 };
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split(/\r?\n/).length;
    return { added: lines, removed: 0 };
  }

  try {
    const cmd = stagedOnly
      ? `git diff --cached --numstat -- "${filePath}"`
      : `git diff --numstat -- "${filePath}"`;
    const out = execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    const line = out.split("\n")[0]?.trim();
    if (!line) return { added: 0, removed: 0 };
    const parts = line.split(/\s+/);
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

export function getExportDelta(
  repoRoot: string,
  filePath: string,
  stagedOnly: boolean,
): ExportDelta {
  const fullPath = path.join(repoRoot, filePath);
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  if (!exts.some((e) => filePath.endsWith(e))) {
    return { newExports: [], modifiedExports: [] };
  }

  let addedLines = "";
  let removedLines = "";

  if (!isTracked(repoRoot, filePath) && fs.existsSync(fullPath)) {
    addedLines = fs.readFileSync(fullPath, "utf8");
  } else {
    try {
      const cmd = stagedOnly
        ? `git diff --cached -- "${filePath}"`
        : `git diff -- "${filePath}"`;
      const diff = execSync(cmd, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
      for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          addedLines += line.slice(1) + "\n";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          removedLines += line.slice(1) + "\n";
        }
      }
    } catch {
      // no diff or error
    }
  }

  const newInAdded = new Set<string>();
  const inRemoved = new Set<string>();
  for (const line of addedLines.split(/\r?\n/)) {
    for (const name of extractExportNamesFromLine(line)) {
      newInAdded.add(name);
    }
  }
  for (const line of removedLines.split(/\r?\n/)) {
    for (const name of extractExportNamesFromLine(line)) {
      inRemoved.add(name);
    }
  }

  const newExports = Array.from(newInAdded).filter((n) => !inRemoved.has(n));
  const modifiedExports = Array.from(newInAdded).filter((n) => inRemoved.has(n));

  return { newExports, modifiedExports };
}

export function getRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

const EXTS_FOR_EXPORTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Batch: last modified time per file. One git log + fs.stat for untracked. */
export function getAllFileTimestamps(
  repoRoot: string,
  files: string[],
): Map<string, number> {
  const fileSet = new Set(files);
  const result = new Map<string, number>();
  const now = Math.floor(Date.now() / 1000);

  try {
    const out = execSync("git log -500 --format=%ct --name-only", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    let currentTs = now;
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) {
        currentTs = parseInt(t, 10) || now;
        continue;
      }
      const normalized = t.replace(/^a\//, "").replace(/^b\//, "");
      if (fileSet.has(normalized) && !result.has(normalized)) {
        result.set(normalized, currentTs);
      }
    }
  } catch {
    // ignore
  }

  for (const file of files) {
    if (result.has(file)) continue;
    try {
      const stat = fs.statSync(path.join(repoRoot, file));
      result.set(file, Math.floor(stat.mtimeMs / 1000));
    } catch {
      result.set(file, now);
    }
  }
  return result;
}

/** Batch: numstat for all changed files. One git diff --numstat. */
export function getAllDiffStats(
  repoRoot: string,
  files: string[],
  stagedOnly: boolean,
): Map<string, FileDiffStats> {
  const result = new Map<string, FileDiffStats>();

  try {
    const cmd = stagedOnly
      ? "git diff --cached --numstat"
      : "git diff --numstat";
    const out = execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const added = parseInt(parts[0], 10) || 0;
      const removed = parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join(" ").replace(/^a\//, "").replace(/^b\//, "");
      result.set(filePath, { added, removed });
    }
  } catch {
    // ignore
  }

  for (const file of files) {
    if (result.has(file)) continue;
    const fullPath = path.join(repoRoot, file);
    if (!fs.existsSync(fullPath)) {
      result.set(file, { added: 0, removed: 0 });
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/).length;
      result.set(file, { added: lines, removed: 0 });
    } catch {
      result.set(file, { added: 0, removed: 0 });
    }
  }
  return result;
}

/** Batch: full diff parsed by file, then export deltas. One git diff. */
export function getAllExportDeltas(
  repoRoot: string,
  files: string[],
  stagedOnly: boolean,
): Map<string, ExportDelta> {
  const result = new Map<string, ExportDelta>();
  const fileSet = new Set(files);

  const empty: ExportDelta = { newExports: [], modifiedExports: [] };

  const parseAddedRemoved = (addedLines: string, removedLines: string): ExportDelta => {
    const newInAdded = new Set<string>();
    const inRemoved = new Set<string>();
    for (const line of addedLines.split(/\r?\n/)) {
      for (const name of extractExportNamesFromLine(line)) {
        newInAdded.add(name);
      }
    }
    for (const line of removedLines.split(/\r?\n/)) {
      for (const name of extractExportNamesFromLine(line)) {
        inRemoved.add(name);
      }
    }
    return {
      newExports: Array.from(newInAdded).filter((n) => !inRemoved.has(n)),
      modifiedExports: Array.from(newInAdded).filter((n) => inRemoved.has(n)),
    };
  };

  try {
    const cmd = stagedOnly ? "git diff --cached" : "git diff";
    const out = execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    const chunks = out.split(/diff --git /);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const firstLine = chunk.split(/\r?\n/)[0];
      if (!firstLine) continue;
      const match = firstLine.match(/^a\/(.+?)\s+b\//) || firstLine.match(/^(.+?)\s+b\//);
      const filePath = match ? match[1]!.replace(/^a\//, "") : "";
      if (!filePath || !fileSet.has(filePath)) continue;

      let addedLines = "";
      let removedLines = "";
      for (const line of chunk.split(/\r?\n/).slice(1)) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          addedLines += line.slice(1) + "\n";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          removedLines += line.slice(1) + "\n";
        }
      }
      result.set(filePath, parseAddedRemoved(addedLines, removedLines));
    }
  } catch {
    // ignore
  }

  for (const file of files) {
    if (result.has(file)) continue;
    if (!EXTS_FOR_EXPORTS.some((e) => file.endsWith(e))) {
      result.set(file, empty);
      continue;
    }
    const fullPath = path.join(repoRoot, file);
    if (!fs.existsSync(fullPath)) {
      result.set(file, empty);
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      result.set(file, parseAddedRemoved(content, ""));
    } catch {
      result.set(file, empty);
    }
  }
  return result;
}
