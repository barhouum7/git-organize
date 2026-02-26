import { execSync } from "child_process";
import * as path from "path";

export interface AnalyzeOptions {
  stagedOnly?: boolean;
}

interface ChangeGroup {
  id: number;
  key: string;
  files: string[];
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

    const output = execSync("git status --porcelain", {
      encoding: "utf8",
    });

    if (!output.trim()) {
      return [];
    }

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(" ");
        return parts[parts.length - 1] ?? "";
      })
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      "Failed to read git changes. Are you running inside a git repository?",
    );
  }
}

function groupByDirectory(files: string[]): ChangeGroup[] {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const dir = path.dirname(file);
    const key = dir === "." ? "(repo root)" : dir;
    const existing = groups.get(key);
    if (existing) {
      existing.push(file);
    } else {
      groups.set(key, [file]);
    }
  }

  let counter = 1;
  return Array.from(groups.entries()).map(([key, groupFiles]) => ({
    id: counter++,
    key,
    files: groupFiles.sort(),
  }));
}

function suggestBranchName(key: string): string {
  if (key === "(repo root)") {
    return "chore/root-changes";
  }

  const sanitized = key
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

  const groups = groupByDirectory(files);

  // eslint-disable-next-line no-console
  console.log(`Detected ${groups.length} logical group(s):\n`);

  for (const group of groups) {
    const branchName = suggestBranchName(group.key);

    // eslint-disable-next-line no-console
    console.log(`[${group.id}] ${group.key} (${group.files.length} file(s))`);
    for (const file of group.files) {
      // eslint-disable-next-line no-console
      console.log(`  - ${file}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n  Suggested branch: ${branchName}\n`);
  }
}

