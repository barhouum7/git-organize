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
