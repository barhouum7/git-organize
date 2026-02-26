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

- **Detect** changed files in your working tree
- **Group** them by directory (as a simple first-pass heuristic)
- **Suggest** a branch name for each group

Only want to consider staged changes?

```bash
git-organize analyze --staged-only
```

### v0.1 Scope

- **Heuristic grouping** by directory only (no AST/semantic analysis yet)
- **Safe, read-only**: the tool does not create branches or modify git state
- **Human-in-the-loop**: you take the suggested groupings and branch names and apply them however you like

Future versions can grow into deeper, context-aware grouping using imports, dependency graphs, and AI assistance.

