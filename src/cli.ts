#!/usr/bin/env node
import { Command } from "commander";
import { printAnalysisResult, runAnalysisSync } from "./analysis";
import { runInteractive } from "./interactive";

const program = new Command();

program
  .name("git-organize")
  .description(
    "Analyze git working tree changes and suggest logical groups and branch names.",
  )
  .version("0.1.0");

program
  .command("analyze")
  .description(
    "Analyze uncommitted changes and print suggested groups and branch names.",
  )
  .option("--staged-only", "Only include staged changes")
  .option("--json", "Output result as JSON for scripting")
  .option("--interactive", "Choose a group to create branch and stage files")
  .action(
    async (options: {
      stagedOnly?: boolean;
      json?: boolean;
      interactive?: boolean;
    }) => {
      const opts = { stagedOnly: options.stagedOnly };
      const result = runAnalysisSync(opts);

      if (!result) {
        console.log("No changes detected in the working tree.");
        process.exit(0);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (options.interactive) {
        await runInteractive(result);
        return;
      }

      printAnalysisResult(result);
    },
  );

program.parseAsync(process.argv);
