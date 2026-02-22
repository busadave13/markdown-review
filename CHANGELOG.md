# Changelog

## 0.1.0 — Initial Release

- **Preview-only commenting** — WebView sidebar for adding threaded comments to any markdown file
- **Sidecar JSON storage** — Comments persist as `.comments.json` files alongside markdown docs
- **Section-level anchoring** — Comments anchor to markdown headings via slug + content hash
- **Stale detection** — Comments flagged when the underlying section content drifts
- **Thumbs-up reactions** — Toggle reactions on individual comments
- **Statistics chart** — Open vs resolved thread counts in the sidebar
- **Resolve / Reopen threads** — Mark discussions as resolved with author-gating
- **One-click PR creation** — Publish draft comments as a pull request to GitHub or Azure DevOps
- **Explorer context menu** — Right-click any `.md` file → "Markdown: Review and Comment"
- **Activity Bar sidebar** — New Markdown Threads icon in the Activity Bar opens a sidebar showing all markdown files in the workspace
- **Folder picker** — Filter the sidebar file list by selecting a specific folder from a dropdown
- **Comment count badges** — Sidebar shows comment count for each markdown file
- **Click to preview** — Click any file in the sidebar to open the preview panel
- **Bug fix: Publish button not appearing** — Fixed issue where the Publish button wouldn't appear after adding replies or resolving threads on already-published comments
- **Mermaid rendering** — Mermaid code blocks now render as diagrams in the preview panel
- **Theme-aware diagrams** — Mermaid diagrams automatically adapt to VS Code light/dark theme