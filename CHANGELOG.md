# Changelog

## 0.2.1

- **Cross-platform fix** — Fixed markdown section parsing on Windows (CRLF line endings now handled correctly)
- **Document refresh fix** — Fixed "Section not found" error when adding comments after opening from Explorer context menu

## 0.2.0

- **Publish button in sidebar** — Draft comment count and one-click publish button now appears in the preview sidebar header
- **Activation fix** — Extension now activates reliably when invoked from the Explorer context menu or command palette
- **Dependency packaging fix** — Runtime dependencies are now correctly included in the `.vsix` package
- **License correction** — Updated references from MIT to LGPL-2.1
- **Repository URL fix** — Corrected repository references from `markdown-discussions` to `markdown-review`

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
