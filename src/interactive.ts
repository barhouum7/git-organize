import * as readline from "readline";
import { execSync } from "child_process";
import pc from "picocolors";
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
  parts.push(`${pc.green(`+${d.added}`)} ${pc.red(`-${d.removed}`)}`);
  if (d.newExports.length > 0) {
    parts.push(`${pc.magentaBright(`New exports:`)} ${d.newExports.join(", ")}`);
  }
  if (d.modifiedExports.length > 0) {
    parts.push(`${pc.magentaBright(`Modified exports:`)} ${d.modifiedExports.join(", ")}`);
  }
  return parts.join(" | ");
}

function printGroups(result: AnalysisResult): void {
  const { groups } = result;
  console.log("");
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
      `  ${pc.bold(
        pc.white(`[${group.id}]`),
      )} ${pc.bold(pc.cyan(group.label))} (${group.files.length} file(s)) — ${pc.blueBright(`Confidence:`)} ${confidenceColored}`,
    );
    for (const file of group.files) {
      console.log(`      ${pc.dim("-")} ${file}`);
    }
    console.log(
      `      ${pc.magentaBright("Branch:")} ${pc.bold(pc.green(group.suggestedBranch))}`,
    );
    console.log(`      ${pc.magentaBright("Diff:")} ${formatDiffSummary(group)}`);
    if (group.timeStats) {
      console.log(
        `      ${pc.magentaBright("Time:")} span ${pc.cyan(group.timeStats.spanLabel)} | last ${pc.cyan(group.timeStats.lastModifiedLabel)}
        File: ${pc.yellow(displayFile)} (${new Date(group.timeStats.latest * 1000).toLocaleString()})
        `,
      );
    }
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

function getDefaultBaseBranch(repoRoot: string): string {
  // try {
  //   const remote = execSync("git remote", { cwd: repoRoot, encoding: "utf8" }).trim();
  //   if (remote) {
  //     const defaultBranch = execSync(`git remote show ${remote} | grep 'HEAD branch'`, {
  //       cwd: repoRoot,
  //       encoding: "utf8",
  //     })
  //       .split(":")
  //       .pop()
  //       ?.trim();
  //     if (defaultBranch) return defaultBranch;
  //   }
  // } catch {
  //   // Ignore errors and fallback to 'main'
  // }
  
  // For now we'll just default to master/main without trying to detect the remote default branch, to avoid issues in ssh key passphrase prompts or other git config issues. We can add this back later with better error handling if needed.
  const commonDefaults = ["main", "master"];
  for (const branch of commonDefaults) {
    try {
      execSync(`git rev-parse --verify ${branch}`, { cwd: repoRoot, stdio: "ignore" });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }
  // If neither main nor master exists, just return main and let git handle the error if it doesn't exist.
  return "main";
}

function createBranchAndStage(
  repoRoot: string,
  baseBranch: string,
  defaultBase: string,
  group: ChangeGroup,
): void {
  const branch = group.suggestedBranch;
  // execSync(`git checkout "${baseBranch}"`, { cwd: repoRoot, stdio: "inherit" });
  // Always base on default branch to avoid issues if user is on a detached HEAD or other non-branch state.
  execSync(`git checkout "${defaultBase}"`, { cwd: repoRoot, stdio: "inherit" });
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
  const defaultBase = getDefaultBaseBranch(repoRoot);

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
    createBranchAndStage(repoRoot, baseBranch, defaultBase, group);
  }

  if (selected.length === 1) {
    console.log("Done. You are on the new branch with files staged.");
  } else {
    console.log(
      "Done. You are on the last created branch. Switch with `git checkout <branch>`.",
    );
  }
}
