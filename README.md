## git-organize

CLI to analyze your current git working tree changes and suggest logical groups and branch names.

### Install (local dev)

```bash
npm install
npm run build
```

You can then run:

```bash
node dist/cli.js analyze
```

Or, after a global install from a published package:

```bash
git-organize analyze
```

### Usage

From inside any git repository with uncommitted changes:

```bash
git-organize analyze
```

This will:

- **Detect** changed files (using `git diff` and untracked files)
- **Ignore** noise like `node_modules`, `dist`, `.next`, etc.
- **Group** changes into clusters by directory and import relationships
- **Show** per cluster: confidence score, suggested branch, and a **diff summary** (added/removed lines, new and modified exports)
- **Suggest** a branch name for each cluster

**Staged changes only:**

```bash
git-organize analyze --staged-only
```

**Machine-readable output for scripting:**

```bash
git-organize analyze --json
```

**Interactive mode — create a branch and stage a group:**

```bash
git-organize analyze --interactive
```

You’ll see the same groups and summaries, then be prompted to choose one or more group numbers (e.g. `1`, `2,3`, or `all`). For each chosen group, the CLI will create the suggested branch from your current branch and stage that group’s files. You can then commit.

### Output details

- **Confidence score** — How coherent the cluster is (same directory and/or import links → higher score).
- **Diff summary** — For each cluster: `+added -removed` line counts, plus **new exports** and **modified exports** detected from TS/JS/TSX/JSX (regex-based, no AI).

Example:

```
[1] src (4 file(s)) — Confidence: 100%
  - src/analysis.ts
  - src/cli.ts
  ...
  Suggested branch: feature/src
  Diff: +463 -47 | New exports: runAnalysisSync, ... | Modified exports: runAnalysis
```

### v0.1 Scope

- **Heuristic grouping** using directory and import co-occurrence (no deep AST/AI yet).
- **Interactive mode** creates branches and stages files; default behavior is read-only.
- **JSON** output for piping into other tools.

Future versions can add richer dependency analysis and optional AI-assisted labels.
