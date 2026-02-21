# Markdown Review

Add threaded review comments to any markdown file in your Git repository — right from VS Code. Comments are stored as sidecar JSON files alongside your docs, and can be published as pull requests to GitHub or Azure DevOps with one click.

## Features

- **Preview sidebar** — Right-click any `.md` file → "Markdown: Review and Comment" to open a rendered preview with an inline comment sidebar
- **Threaded comments** — Add, reply to, edit, and delete comments anchored to markdown sections
- **Reactions** — Thumbs-up reactions on individual comments
- **Resolve / Reopen** — Mark threads as resolved; resolved threads lock further edits
- **Stale detection** — Comments are flagged when the underlying section content changes
- **Statistics chart** — See open vs resolved thread counts at a glance
- **Draft mode** — Comments are saved locally as drafts until you publish
- **One-click PR creation** — Publish all draft comments as a pull request to GitHub or Azure DevOps

## How It Works

1. Right-click any `.md` file in the Explorer → **"Markdown: Review and Comment"**
2. The preview panel opens beside your editor with a comment sidebar
3. Click **Add Comment** on any section heading to start a thread
4. When ready, run **"Publish Pending Comments as PR"** from the command palette or status bar

Comments are stored in a `.comments.json` sidecar file next to each document:

```
docs/
  feature-x.md
  feature-x.comments.json    ← created automatically
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `markdownReview.autoOpenPR` | `true` | Open browser to PR after creation |
| `markdownReview.branchPrefix` | `"doc-comment"` | Prefix for comment branches |
| `markdownReview.defaultProvider` | `"auto"` | Git provider (`auto`, `github`, `azuredevops`) |

## Anchoring

Comments anchor to markdown sections using a hybrid of heading slug, content hash, and line hint. When the content under a heading changes, the comment is flagged as **stale** rather than lost.

## Requirements

- VS Code 1.85.0+
- Git repository with a GitHub or Azure DevOps remote
- Sign in to your GitHub or Microsoft account in VS Code for PR creation

## Installation

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) or:

1. Download the `.vsix` file from [Releases](https://github.com/busadave13/markdown-review/releases)
2. In VS Code: **Extensions → ··· → Install from VSIX…**

## Development

```bash
npm install
npm run compile
npm run test       # Mocha + @vscode/test-electron
```

Press **F5** to launch the Extension Development Host.

## License

LGPL-2.1 — see [LICENSE](LICENSE) for details.
