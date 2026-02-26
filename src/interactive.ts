import * as readline from "readline";
import { execSync } from "child_process";
import type { AnalysisResult, ChangeGroup } from "./analysis";
import { getRepoRoot } from "./diff-summary";

function createInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer ?? "").trim()));
  });
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

function printGroups(result: AnalysisResult): void {
  const { groups } = result;
  console.log(`\nDetected ${groups.length} logical group(s):\n`);
  for (const group of groups) {
    console.log(
      `  [${group.id}] ${group.label} (${group.files.length} file(s)) — Confidence: ${(group.confidence * 100).toFixed(0)}%`,
    );
    for (const file of group.files) {
      console.log(`      - ${file}`);
    }
    console.log(`      Branch: ${group.suggestedBranch}`);
    console.log(`      Diff: ${formatDiffSummary(group)}`);
    console.log("");
  }
}

function getCurrentBranch(repoRoot: string): string {
  const name = execSync("git branch --show-current", {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return name || "HEAD";
}

function createBranchAndStage(
  repoRoot: string,
  baseBranch: string,
  group: ChangeGroup,
): void {
  const branch = group.suggestedBranch;
  execSync(`git checkout "${baseBranch}"`, { cwd: repoRoot, stdio: "inherit" });
  execSync(`git checkout -b "${branch}"`, { cwd: repoRoot, stdio: "inherit" });
  for (const file of group.files) {
    execSync(`git add "${file}"`, { cwd: repoRoot, stdio: "inherit" });
  }
  console.log(
    `\nBranch "${branch}" created and ${group.files.length} file(s) staged. You can commit now.`,
  );
}

export async function runInteractive(result: AnalysisResult): Promise<void> {
  const repoRoot = getRepoRoot();
  const rl = createInterface();

  printGroups(result);

  const prompt =
    "Choose group number to create branch and stage files (e.g. 1 or 2,3 or 'q' to quit): ";
  const raw = await question(rl, prompt);
  rl.close();

  if (raw.toLowerCase() === "q" || raw === "") {
    console.log("No action taken.");
    return;
  }

  const ids = new Set<number>();
  if (raw.toLowerCase() === "all") {
    result.groups.forEach((g) => ids.add(g.id));
  } else {
    for (const part of raw.split(/[\s,]+/)) {
      const num = parseInt(part, 10);
      if (Number.isFinite(num) && result.groups.some((g) => g.id === num)) {
        ids.add(num);
      }
    }
  }

  if (ids.size === 0) {
    console.log("No valid group selected.");
    return;
  }

  const selected = result.groups.filter((g) => ids.has(g.id));
  if (selected.length === 0) {
    console.log("No valid group selected.");
    return;
  }

  const baseBranch = getCurrentBranch(repoRoot);

  for (let i = 0; i < selected.length; i++) {
    const group = selected[i]!;
    if (i > 0) {
      const again = await new Promise<string>((resolve) => {
        const r2 = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        r2.question(
          `Create branch for group [${group.id}] "${group.suggestedBranch}"? (y/n): `,
          (a) => {
            r2.close();
            resolve((a ?? "").trim().toLowerCase());
          },
        );
      });
      if (again !== "y" && again !== "yes") continue;
    }
    createBranchAndStage(repoRoot, baseBranch, group);
  }

  if (selected.length === 1) {
    console.log("Done. You are on the new branch with files staged.");
  } else {
    console.log(
      "Done. You are on the last created branch. Switch with `git checkout <branch>`.",
    );
  }
}
