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

- **Detect** changed files in your working tree (using a combination of `git diff` and untracked files)
- **Ignore obvious noise** like `node_modules`, `dist`, `.next`, etc.
- **Group** them into logical clusters based on directory and simple import relationships between files
- **Suggest** a branch name for each cluster

Only want to consider staged changes?

```bash
git-organize analyze --staged-only
```

### v0.1 Scope

- **Heuristic grouping** using directory and basic import co-occurrence (no deep AST/semantic analysis yet)
- **Safe, read-only**: the tool does not create branches or modify git state
- **Human-in-the-loop**: you take the suggested groupings and branch names and apply them however you like

Future versions can grow into deeper, context-aware grouping using richer dependency graphs and AI assistance.

