#!/usr/bin/env node
import { Command } from "commander";
import { runAnalysis } from "./analysis";

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
  .action((options: { stagedOnly?: boolean }) => {
    runAnalysis({ stagedOnly: options.stagedOnly });
  });

program.parseAsync(process.argv);

