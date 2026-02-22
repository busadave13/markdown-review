import * as vscode from 'vscode';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { sidecarManager } from './sidecarManager';
import type { SidecarChangeEvent } from './sidecarManager';
import { anchorEngine } from './anchorEngine';
import { gitService } from './gitService';
import { gitHubProvider } from './providers/githubProvider';
import { adoProvider } from './providers/adoProvider';
import { slugify } from './utils/hash';
import { markdownItMermaid } from './utils/markdownItMermaid';
import type { CommentThread as AppCommentThread } from './models/types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Manages a WebView panel that renders the markdown document
 * with inline comment threads visible — a "preview with comments" mode.
 */
export class PreviewPanel implements vscode.Disposable {
  public static readonly viewType = 'markdownThreads.preview';

  private static instance: PreviewPanel | undefined;
  private static extensionUri: vscode.Uri | undefined;

  private readonly panel: vscode.WebviewPanel;
  private document: vscode.TextDocument;
  private readonly md: MarkdownIt;
  private readonly disposables: vscode.Disposable[] = [];
  private updateTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly mermaidUri: vscode.Uri;

  // ───────────────── public API ─────────────────

  /** Set the extension URI (call once during activation). */
  public static setExtensionUri(uri: vscode.Uri): void {
    PreviewPanel.extensionUri = uri;
  }

  /** Create a new preview panel or reveal an existing one. */
  public static async show(document: vscode.TextDocument): Promise<void> {
    if (PreviewPanel.instance) {
      PreviewPanel.instance.document = document;
      PreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      await PreviewPanel.instance.update();
      return;
    }

    if (!PreviewPanel.extensionUri) {
      vscode.window.showErrorMessage('PreviewPanel.extensionUri not set');
      return;
    }

    const mermaidPath = vscode.Uri.joinPath(
      PreviewPanel.extensionUri,
      'node_modules',
      'mermaid',
      'dist',
      'mermaid.min.js'
    );

    const localResourceRoots = [
      ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
      vscode.Uri.joinPath(PreviewPanel.extensionUri, 'node_modules'),
    ];

    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      `Preview: ${path.basename(document.uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      },
    );

    PreviewPanel.instance = new PreviewPanel(panel, document, mermaidPath);
    await PreviewPanel.instance.update();
  }

  // ───────────────── constructor ─────────────────

  private constructor(panel: vscode.WebviewPanel, document: vscode.TextDocument, mermaidPath: vscode.Uri) {
    this.panel = panel;
    this.document = document;
    this.mermaidUri = panel.webview.asWebviewUri(mermaidPath);
    this.md = new MarkdownIt({ html: true, linkify: true, typographer: true });
    this.md.use(markdownItMermaid);
    this.installHeadingPlugin();

    // Dispose cleanup
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Re-render on document save (not on every keystroke edit,
    // which would disrupt the comment widget by refreshing the webview)
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.toString() === this.document.uri.toString()) {
          this.scheduleUpdate();
        }
      }),
    );

    // Re-render when sidecar data changes (from any origin except preview itself)
    this.disposables.push(
      sidecarManager.onDidChange((e: SidecarChangeEvent) => {
        if (e.origin === 'preview') {
          // We wrote this ourselves — no need to reload (we already called this.update())
          return;
        }
        // Only refresh if the change is for the document we're currently previewing
        if (e.docPath === this.document.uri.fsPath) {
          this.scheduleUpdate();
        }
      }),
    );

    // Follow the active editor when switching to another markdown file.
    // Ignore VS Code's virtual comment-input documents (scheme !== 'file'
    // or path containing 'commentinput-') to prevent the preview from
    // switching away when the user clicks a comment widget.
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (
          editor &&
          editor.document.languageId === 'markdown' &&
          editor.document.uri.scheme === 'file' &&
          !editor.document.uri.path.includes('commentinput-') &&
          editor.document.uri.toString() !== this.document.uri.toString()
        ) {
          this.document = editor.document;
          this.scheduleUpdate();
        }
      }),
    );

    // Handle messages from the WebView
    this.panel.webview.onDidReceiveMessage(
      msg => this.handleWebViewMessage(msg),
      null,
      this.disposables,
    );
  }

  // ───────────────── Document refresh helper ─────────────────

  /**
   * Ensure this.document is a fresh reference.
   * Needed when the editor tab was closed but the preview panel remains open.
   */
  private async ensureDocumentFresh(): Promise<void> {
    this.document = await vscode.workspace.openTextDocument(this.document.uri);
  }

  // ───────────────── WebView message handler ─────────────────

  private async handleWebViewMessage(msg: { command: string; [key: string]: unknown }): Promise<void> {
    switch (msg.command) {
      case 'openSection': {
        const line = msg.line as number;
        await vscode.window.showTextDocument(this.document.uri, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: false,
        });
        break;
      }

      case 'addComment': {
        await this.ensureDocumentFresh();
        const slug = msg.slug as string;
        const body = (msg.body as string || '').trim();
        if (!body) { return; }

        const author = await gitService.getUserName();
        const sections = anchorEngine.getSections(this.document);
        const section = sections.find(s => s.slug === slug);
        if (!section) {
          vscode.window.showErrorMessage(`Section "${slug}" not found`);
          return;
        }

        let sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) {
          sidecar = sidecarManager.createEmptySidecar(path.basename(this.document.uri.fsPath));
        }

        const anchor = anchorEngine.createAnchor(section);
        const now = new Date().toISOString();
        sidecarManager.addThread(sidecar, {
          anchor,
          status: 'open',
          isDraft: true,
          thread: [{ id: uuidv4(), author, body, created: now, edited: null }],
        });

        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'replyComment': {
        const threadId = msg.threadId as string;
        const body = (msg.body as string || '').trim();
        if (!body || !threadId) { return; }

        const author = await gitService.getUserName();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }

        // Block reply on resolved threads
        const replyThread = sidecar.comments.find(t => t.id === threadId);
        if (replyThread && replyThread.status === 'resolved') {
          vscode.window.showWarningMessage('Cannot reply to a resolved thread. Reopen it first.');
          return;
        }

        sidecarManager.addReply(sidecar, threadId, {
          author,
          body,
          created: new Date().toISOString(),
          edited: null,
        });

        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'resolveThread': {
        const threadId = msg.threadId as string;
        if (!threadId) { return; }
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        sidecarManager.updateThreadStatus(sidecar, threadId, 'resolved');
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'reopenThread': {
        const threadId = msg.threadId as string;
        if (!threadId) { return; }
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        sidecarManager.updateThreadStatus(sidecar, threadId, 'open');
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'deleteThread': {
        const threadId = msg.threadId as string;
        if (!threadId) { return; }
        const currentUser = await gitService.getUserName();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        const thread = sidecar.comments.find(t => t.id === threadId);
        if (!thread) { return; }
        // Block delete on resolved threads
        if (thread.status === 'resolved') {
          vscode.window.showWarningMessage('Cannot delete a resolved thread. Reopen it first.');
          return;
        }
        // Only the thread creator (first comment author) may delete the thread
        if (thread.thread[0]?.author !== currentUser) {
          vscode.window.showWarningMessage('You can only delete threads you created.');
          return;
        }
        sidecarManager.deleteThread(sidecar, threadId);
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'reparentThread': {
        const threadId = msg.threadId as string;
        const newSlug = msg.newSlug as string;
        if (!threadId || !newSlug) { return; }
        await this.ensureDocumentFresh();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        // Find the target section
        const sections = anchorEngine.parseSections(this.document);
        const targetSection = sections.find(s => s.slug === newSlug);
        if (!targetSection) {
          vscode.window.showWarningMessage('Target section not found.');
          return;
        }
        // Create new anchor and reparent
        const newAnchor = anchorEngine.createAnchor(targetSection);
        const success = sidecarManager.reparentThread(sidecar, threadId, newAnchor);
        if (!success) {
          vscode.window.showWarningMessage('Thread not found.');
          return;
        }
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        console.log(`[MarkdownThreads] Reparented thread ${threadId} to section "${targetSection.heading}"`);
        await this.update();
        break;
      }

      case 'deleteComment': {
        const threadId = msg.threadId as string;
        const commentId = msg.commentId as string;
        if (!threadId || !commentId) { return; }
        const currentUser = await gitService.getUserName();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        const thread = sidecar.comments.find(t => t.id === threadId);
        if (!thread) { return; }
        // Block delete on resolved threads
        if (thread.status === 'resolved') {
          vscode.window.showWarningMessage('Cannot delete a comment in a resolved thread. Reopen it first.');
          return;
        }
        const entry = thread.thread.find(c => c.id === commentId);
        if (!entry) { return; }
        // Only the comment author may delete their own comment
        if (entry.author !== currentUser) {
          vscode.window.showWarningMessage('You can only delete your own comments.');
          return;
        }
        sidecarManager.deleteCommentById(sidecar, threadId, commentId);
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'toggleReaction': {
        const threadId = msg.threadId as string;
        const commentId = msg.commentId as string;
        if (!threadId || !commentId) { return; }
        const currentUser = await gitService.getUserName();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        sidecarManager.toggleReaction(sidecar, threadId, commentId, currentUser);
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }

      case 'publishDrafts': {
        await this.handlePublishFromPreview();
        await this.update();
        break;
      }

      case 'editComment': {
        const threadId = msg.threadId as string;
        const commentId = msg.commentId as string;
        const body = (msg.body as string || '').trim();
        if (!threadId || !commentId || !body) { return; }
        const currentUser = await gitService.getUserName();
        const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
        if (!sidecar) { return; }
        // Block edit on resolved threads
        const editThread = sidecar.comments.find(t => t.id === threadId);
        if (!editThread) { return; }
        if (editThread.status === 'resolved') {
          vscode.window.showWarningMessage('Cannot edit a comment in a resolved thread. Reopen it first.');
          return;
        }
        // Verify ownership
        const editEntry = editThread.thread.find(c => c.id === commentId);
        if (!editEntry || editEntry.author !== currentUser) {
          vscode.window.showWarningMessage('You can only edit your own comments.');
          return;
        }
        sidecarManager.editComment(sidecar, threadId, commentId, body);
        await sidecarManager.writeSidecar(this.document.uri.fsPath, sidecar, 'preview');
        await this.update();
        break;
      }
    }
  }

  // ───────────────── markdown-it heading plugin ─────────────────

  /** Adds slug-based IDs and data attributes to heading tokens. */
  private installHeadingPlugin(): void {
    const originalRule = this.md.renderer.rules.heading_open;

    this.md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const nextToken = tokens[idx + 1];
      if (nextToken?.type === 'inline' && nextToken.content) {
        const slug = slugify(nextToken.content);
        token.attrSet('id', slug);
        token.attrSet('data-slug', slug);
        token.attrJoin('class', 'section-heading');
      }
      if (originalRule) {
        return originalRule(tokens, idx, options, env, self);
      }
      return self.renderToken(tokens, idx, options);
    };
  }

  // ───────────────── update / render ─────────────────

  private scheduleUpdate(): void {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    // Only refresh when the panel is actually visible to the user
    if (!this.panel.visible) {
      return;
    }
    this.updateTimeout = setTimeout(() => this.update(), 300);
  }

  private async update(): Promise<void> {
    // Ensure document reference is fresh (in case editor tab was closed)
    await this.ensureDocumentFresh();

    // Fresh section parse
    anchorEngine.clearCache(this.document.uri.toString());
    const sections = anchorEngine.getSections(this.document);

    // Render markdown → HTML
    let html = this.md.render(this.document.getText());
    html = this.fixLocalImagePaths(html);

    // Build per-slug comment data
    const sidecar = await sidecarManager.readSidecar(this.document.uri.fsPath);
    const commentsBySlug: Record<string, { thread: AppCommentThread; isStale: boolean; reparentCandidate?: { slug: string; heading: string } }[]> = {};

    if (sidecar) {
      for (const thread of sidecar.comments) {
        const result = anchorEngine.findAnchoredSection(sections, thread.anchor);
        const slug = thread.anchor.sectionSlug;
        
        // Check for reparent candidate if section not found (orphaned)
        let reparentCandidate: { slug: string; heading: string } | undefined;
        if (!result) {
          const candidate = anchorEngine.findReparentCandidate(sections, thread.anchor);
          if (candidate) {
            reparentCandidate = { slug: candidate.slug, heading: candidate.heading };
          }
        }
        
        (commentsBySlug[slug] ??= []).push({
          thread,
          isStale: result ? result.isStale : true,
          reparentCandidate,
        });
      }
    }

    // slug → line map for click navigation
    const sectionLines: Record<string, number> = {};
    for (const s of sections) {
      sectionLines[s.slug] = s.startLine;
    }

    // All available sections for manual reparent dropdown
    const allSections = sections.map(s => ({ slug: s.slug, heading: s.heading }));

    // Resolve current user for author-gated actions
    const currentUser = await gitService.getUserName();

    this.panel.title = `Preview: ${path.basename(this.document.uri.fsPath)}`;
    this.panel.webview.html = this.buildHtml(html, commentsBySlug, sectionLines, currentUser, allSections);
  }

  /** Convert relative image paths to webview-safe URIs. */
  private fixLocalImagePaths(html: string): string {
    const docDir = path.dirname(this.document.uri.fsPath);
    return html.replace(
      /(<img[^>]*\ssrc=")(?!https?:\/\/|data:)([^"]+)/g,
      (_match, prefix: string, src: string) => {
        const absPath = path.resolve(docDir, src);
        const webviewUri = this.panel.webview.asWebviewUri(vscode.Uri.file(absPath));
        return prefix + webviewUri.toString();
      },
    );
  }

  // ───────────────── HTML template ─────────────────

  private buildHtml(
    renderedMarkdown: string,
    commentsBySlug: Record<string, { thread: AppCommentThread; isStale: boolean; reparentCandidate?: { slug: string; heading: string } }[]>,
    sectionLines: Record<string, number>,
    currentUser: string,
    allSections: { slug: string; heading: string }[],
  ): string {
    const nonce = getNonce();
    const cspSource = this.panel.webview.cspSource;
    // Prevent </script> inside JSON from breaking the page
    const commentsJson = JSON.stringify(commentsBySlug).replace(/</g, '\\u003c');
    const linesJson = JSON.stringify(sectionLines);
    const userJson = JSON.stringify(currentUser).replace(/</g, '\\u003c');
    const sectionsJson = JSON.stringify(allSections).replace(/</g, '\\u003c');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval'; img-src ${cspSource} https: data:; font-src ${cspSource};">
  <script src="${this.mermaidUri}"></script>
  <style>
${PREVIEW_CSS}
  </style>
</head>
<body>
  <div id="layout">
    <div id="content">
      ${renderedMarkdown}
    </div>
    <div id="resize-handle" title="Drag to resize sidebar"></div>
    <div id="sidebar">
      <div class="sidebar-header">
        <span>Threads <span id="thread-count-badge" class="thread-count-badge"></span></span>
        <button id="publish-btn" class="publish-btn" style="display:none" title="Publish draft comments as PR">Publish</button>
      </div>
      <div id="sidebar-content"></div>
      <div id="sidebar-stats"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const commentsBySlug = ${commentsJson};
    const sectionLines = ${linesJson};
    const currentUser = ${userJson};
    const allSections = ${sectionsJson};
${PREVIEW_JS}
  </script>
</body>
</html>`;
  }

  // ───────────────── publish from preview ─────────────────

  private async handlePublishFromPreview(): Promise<void> {
    const docPath = this.document.uri.fsPath;
    const sidecar = await sidecarManager.readSidecar(docPath);

    if (!sidecar) {
      vscode.window.showInformationMessage('No comments to publish');
      return;
    }

    const draftThreads = sidecarManager.getDraftThreads(sidecar);
    if (draftThreads.length === 0) {
      vscode.window.showInformationMessage('No draft comments to publish');
      return;
    }

    const config = vscode.workspace.getConfiguration('markdownThreads');
    const defaultProvider = config.get<string>('defaultProvider', 'auto');

    let providerInfo = await gitService.detectProvider();
    if (defaultProvider !== 'auto' && providerInfo) {
      providerInfo = { ...providerInfo, provider: defaultProvider as 'github' | 'azuredevops' };
    }

    if (!providerInfo) {
      vscode.window.showErrorMessage('Could not detect git provider. Make sure you have a remote configured.');
      return;
    }

    const docName = path.basename(docPath);
    const currentBranch = await gitService.getCurrentBranch();
    const branchName = await gitService.createCommentBranch(docName);

    if (!branchName) {
      vscode.window.showErrorMessage('Failed to create branch for comments');
      return;
    }

    sidecarManager.markAllPublished(sidecar);
    await sidecarManager.writeSidecar(docPath, sidecar, 'internal');

    const sidecarPath = sidecarManager.getSidecarPath(docPath);
    const committed = await gitService.commitSidecarChanges(sidecarPath, docName);

    if (!committed) {
      vscode.window.showErrorMessage('Failed to commit changes');
      if (currentBranch) { await gitService.checkoutBranch(currentBranch); }
      return;
    }

    const pushed = await gitService.pushBranch(branchName);
    if (!pushed) {
      vscode.window.showErrorMessage('Failed to push branch');
      if (currentBranch) { await gitService.checkoutBranch(currentBranch); }
      return;
    }

    const baseBranch = await gitService.getDefaultBranch();
    const title = `Feedback on ${docName}`;
    const body = `This PR contains ${draftThreads.length} comment thread(s) on ${docName}.\n\nCreated by Markdown Review extension.`;

    let result;
    if (providerInfo.provider === 'github') {
      result = await gitHubProvider.createPullRequest(providerInfo, branchName, baseBranch, title, body);
    } else if (providerInfo.provider === 'azuredevops') {
      result = await adoProvider.createPullRequest(providerInfo, branchName, baseBranch, title, body);
    } else {
      vscode.window.showErrorMessage('Unsupported git provider');
      if (currentBranch) { await gitService.checkoutBranch(currentBranch); }
      return;
    }

    if (currentBranch) { await gitService.checkoutBranch(currentBranch); }

    if (result.success && result.prUrl) {
      const autoOpen = config.get<boolean>('autoOpenPR', true);
      if (autoOpen) {
        vscode.env.openExternal(vscode.Uri.parse(result.prUrl));
      }
      vscode.window.showInformationMessage(`PR created: ${result.prUrl}`);
    } else {
      vscode.window.showErrorMessage(`Failed to create PR: ${result.error}`);
    }
  }

  // ───────────────── dispose ─────────────────

  dispose(): void {
    PreviewPanel.instance = undefined;
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ───────────────── helpers ─────────────────

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ───────────────── CSS ─────────────────

const PREVIEW_CSS = /* css */ `
* { box-sizing: border-box; }

body {
  font-family: var(--vscode-markdown-font-family,
    var(--vscode-font-family, -apple-system, BlinkMacSystemFont,
    'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif));
  font-size: var(--vscode-markdown-font-size, var(--vscode-font-size, 14px));
  line-height: var(--vscode-markdown-line-height, 1.6);
  color: var(--vscode-foreground);
  background-color: var(--vscode-editor-background);
  margin: 0;
  padding: 0;
  overflow: hidden;
}

/* ── two‑column layout ─────────────────────── */

#layout {
  display: flex;
  height: 100vh;
  width: 100%;
}

#content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 32px;
  word-wrap: break-word;
}

#sidebar {
  width: 360px;
  min-width: 200px;
  max-width: 70vw;
  border-left: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── resize handle ─────────────────────────── */

#resize-handle {
  width: 5px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  transition: background .15s ease;
}
#resize-handle:hover,
#resize-handle.active {
  background: var(--vscode-focusBorder, #007fd4);
}

body.resizing {
  cursor: col-resize !important;
  user-select: none;
}

.sidebar-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
  font-weight: 600;
  font-size: 14px;
  flex-shrink: 0;
  color: var(--vscode-foreground);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.thread-count-badge {
  font-size: 11px;
  font-weight: normal;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  padding: 1px 7px;
  border-radius: 8px;
  margin-left: 6px;
}

.publish-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, #0e639c);
}
.publish-btn:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.publish-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

#sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.sidebar-section {
  padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.12));
}

.sidebar-section.highlighted {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.12));
  transition: background .5s ease;
}

.sidebar-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: .3px;
  margin-bottom: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sidebar-section-title:hover {
  color: var(--vscode-textLink-foreground);
}

.sidebar-section-title .section-comment-count {
  font-size: 11px;
  font-weight: normal;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  padding: 1px 7px;
  border-radius: 8px;
}

.sidebar-empty {
  padding: 20px 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}

/* ── orphaned section ─────────────────────────── */
.sidebar-section.orphaned-section {
  background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,.04));
  border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
}
.orphaned-section-title {
  color: var(--vscode-editorError-foreground, #f14c4c);
}
.orphaned-section-title::before {
  content: '⚠ ';
}

/* ── reparent UI ─────────────────────────────── */
.reparent-bar {
  margin: 8px 0;
  padding: 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,.08));
  border-radius: 4px;
}
.reparent-btn {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.reparent-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
.reparent-btn strong {
  color: var(--vscode-textLink-foreground);
}
.reparent-select {
  background: var(--vscode-dropdown-background, #3c3c3c);
  color: var(--vscode-dropdown-foreground, #ccc);
  border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  min-width: 150px;
}
.reparent-select:focus {
  outline: 1px solid var(--vscode-focusBorder);
}

/* ── typography ─────────────────────────────── */

h1, h2, h3, h4, h5, h6 {
  font-weight: 600;
  margin-top: 24px;
  margin-bottom: 16px;
  line-height: 1.25;
  color: var(--vscode-foreground);
}
h1 { font-size: 2em;   border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35)); padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35)); padding-bottom: .3em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }

p { margin: 0 0 16px; }

a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }

code {
  font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', 'Courier New', monospace);
  font-size: .9em;
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15));
  padding: 2px 6px;
  border-radius: 3px;
}
pre {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15));
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
}
pre code { background: none; padding: 0; }

blockquote {
  margin: 16px 0;
  padding: 0 16px;
  border-left: 4px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,.35));
  color: var(--vscode-textBlockQuote-foreground, inherit);
}

table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td {
  border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
  padding: 8px 12px; text-align: left;
}
th {
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,.1));
  font-weight: 600;
}

img { max-width: 100%; }
hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35)); margin: 24px 0; }

ul, ol { padding-left: 2em; }

/* ── comment badge on headings ─────────────── */

.comment-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: none;
  border-radius: 10px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: normal;
  margin-left: 8px;
  vertical-align: middle;
  cursor: pointer;
  transition: opacity .15s ease;
}
.comment-badge:hover { opacity: .85; }
.comment-badge::before { content: '\\1F4AC'; font-size: 10px; margin-right: 2px; }

/* ── add comment button (on headings) ──────── */

.add-comment-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: none;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 14px;
  cursor: pointer;
  margin-left: 6px;
  vertical-align: middle;
  transition: all .15s ease;
  opacity: 0.6;
}
.add-comment-btn:hover {
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.15));
  color: var(--vscode-foreground);
  opacity: 1;
}

/* ── comment thread blocks (in sidebar) ─────── */

.comment-thread-block {
  border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
  border-radius: 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,.06));
  padding: 10px 14px;
  margin: 6px 0;
  transition: box-shadow 0.2s ease;
  cursor: pointer;
}
.comment-thread-block.focused {
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
}
.comment-thread-block.stale    { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.comment-thread-block.resolved { border-left-color: var(--vscode-testing-iconPassed, #73c991); opacity: .75; }
.comment-thread-block.orphaned { border-left-color: var(--vscode-editorError-foreground, #f14c4c); background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,.08)); }

.thread-status-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .5px;
  margin-bottom: 6px;
}
.thread-status-label.open     { color: var(--vscode-editorInfo-foreground, #3794ff); }
.thread-status-label.resolved { color: var(--vscode-testing-iconPassed, #73c991); }
.thread-status-label.stale    { color: var(--vscode-editorWarning-foreground, #cca700); }
.thread-status-label.orphaned { color: var(--vscode-editorError-foreground, #f14c4c); }

.comment-entry { padding: 6px 0; }
.comment-entry + .comment-entry {
  border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15));
  margin-top: 4px;
}

.comment-header { display: flex; flex-direction: column; gap: 1px; margin-bottom: 2px; }
.comment-author { font-weight: 600; font-size: 12px; color: var(--vscode-textLink-foreground); }
.comment-time   { font-size: 11px; color: var(--vscode-descriptionForeground); }

.comment-draft-badge {
  font-size: 10px; font-weight: 600;
  color: var(--vscode-editorWarning-foreground, #cca700);
  background: var(--vscode-editorWarning-background, rgba(204,167,0,.1));
  padding: 1px 6px; border-radius: 3px;
}

.comment-body { font-size: 13px; line-height: 1.5; margin-top: 2px; white-space: pre-wrap; }

/* ── sidebar add‑comment button ──────────── */

.sidebar-add-comment-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-widget-border, rgba(127,127,127,.25));
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 8px;
  transition: all .15s ease;
}
.sidebar-add-comment-btn:hover {
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.15));
  color: var(--vscode-foreground);
  border-color: var(--vscode-focusBorder);
}

/* ── comment form ──────────────────────────── */

.comment-form {
  margin: 8px 0 4px;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35));
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-input-background, rgba(0,0,0,.15));
}
.comment-form textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 10px;
  border: none;
  outline: none;
  resize: vertical;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: transparent;
}
.comment-form textarea::placeholder { color: var(--vscode-input-placeholderForeground, rgba(127,127,127,.6)); }
.comment-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 6px 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,.06));
}
.comment-form-actions button {
  padding: 4px 14px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.btn-submit {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-submit:hover { background: var(--vscode-button-hoverBackground); }
.btn-cancel {
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.2));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}
.btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }

/* ── thread action buttons ─────────────── */

.thread-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.12));
}
.thread-action-btn {
  background: transparent;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}
.thread-action-btn:hover {
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.15));
}

/* ── comment action links ─────────────────── */

.comment-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.action-link {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  text-decoration: none;
}
.action-link:hover {
  text-decoration: underline;
}

/* ── thumbs-up reaction button ─────────────── */

.reaction-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.15));
  border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2));
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: var(--vscode-foreground);
  line-height: 1.4;
  text-transform: none;
  letter-spacing: 0;
  font-weight: normal;
}
.reaction-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3));
}
.reaction-btn.reacted {
  background: var(--vscode-inputValidation-infoBackground, rgba(30,100,200,.2));
  border-color: var(--vscode-textLink-foreground);
}
.reaction-count {
  font-weight: 600;
  min-width: 8px;
  text-align: center;
}

/* ── collapsed thread divider ──────────────── */

.collapsed-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
  font-weight: 500;
}
.collapsed-divider:hover {
  text-decoration: underline;
}
.collapsed-divider::before,
.collapsed-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--vscode-widget-border, rgba(127,127,127,.25));
}

/* ── sidebar statistics chart ─────────────── */

#sidebar-stats {
  border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2));
  padding: 12px;
  font-size: 12px;
  flex-shrink: 0;
}
.stats-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--vscode-foreground);
}
.stats-bar-container {
  display: flex;
  height: 16px;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,.1));
}
.stats-bar-open {
  background: var(--vscode-charts-blue, #3794ff);
  transition: width 0.3s ease;
}
.stats-bar-resolved {
  background: var(--vscode-charts-green, #89d185);
  transition: width 0.3s ease;
}
.stats-legend {
  display: flex;
  gap: 16px;
  color: var(--vscode-descriptionForeground);
}
.stats-legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.stats-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.stats-dot-open {
  background: var(--vscode-charts-blue, #3794ff);
}
.stats-dot-resolved {
  background: var(--vscode-charts-green, #89d185);
}
.stats-dot-orphaned {
  background: var(--vscode-charts-red, #f14c4c);
}
.stats-bar-orphaned {
  background: var(--vscode-charts-red, #f14c4c);
  transition: width 0.3s ease;
}
.stats-count {
  font-weight: 600;
}

/* ── mermaid diagrams ─────────────────────────── */

pre.mermaid {
  background: transparent;
  border: none;
  text-align: center;
  padding: 16px 0;
}

pre.mermaid svg {
  max-width: 100%;
  height: auto;
}
`;

// ───────────────── JS (runs inside the WebView) ─────────────────

const PREVIEW_JS = /* js */ `
(function () {
  const vscode = acquireVsCodeApi();
  const sidebarContent = document.getElementById('sidebar-content');

  // ── mermaid initialization ─────────────────
  (function initMermaid() {
    if (typeof mermaid !== 'undefined') {
      // Detect VS Code theme (light/dark) from body class or CSS variable
      const isDark = document.body.classList.contains('vscode-dark') ||
                     document.body.classList.contains('vscode-high-contrast') ||
                     getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim().match(/^#[0-4]/);
      mermaid.initialize({
        startOnLoad: true,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'loose',
      });
    }
  })();

  // ── sidebar resize logic ───────────────────
  (function initResize() {
    const handle = document.getElementById('resize-handle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) { return; }
    let startX = 0;
    let startWidth = 0;

    function onMouseDown(e) {
      e.preventDefault();
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(e) {
      const delta = startX - e.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 200), window.innerWidth * 0.7);
      sidebar.style.width = newWidth + 'px';
    }

    function onMouseUp() {
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    handle.addEventListener('mousedown', onMouseDown);
  })();

  // ── helper: create a comment form ──────────
  function createCommentForm(opts) {
    const form = document.createElement('div');
    form.className = 'comment-form';

    const textarea = document.createElement('textarea');
    textarea.placeholder = opts.placeholder || 'Write a comment...';
    form.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'comment-form-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => form.remove());
    actions.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-submit';
    submitBtn.textContent = opts.submitLabel || 'Comment';
    submitBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }
      opts.onSubmit(text);
      form.remove();
    });
    actions.appendChild(submitBtn);

    form.appendChild(actions);

    // Submit on Ctrl/Cmd + Enter
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitBtn.click();
      }
    });

    return { form, textarea };
  }

  // ── helper: expand/collapse thread ─────────
  function expandThread(block) {
    block.classList.add('focused');
    var divider = block.querySelector('.collapsed-divider');
    if (divider) { divider.style.display = 'none'; }
    block.querySelectorAll('.collapsed-entry').forEach(function(el) {
      el.style.display = '';
      el.classList.remove('collapsed-entry');
    });
  }

  function collapseThread(block) {
    if (!block.dataset.collapsible) { return; }
    block.classList.remove('focused');
    var entries = block.querySelectorAll('.comment-entry');
    if (entries.length <= 2) { return; }
    var divider = block.querySelector('.collapsed-divider');
    if (divider) {
      divider.style.display = '';
      var moreCount = entries.length - 2;
      divider.textContent = moreCount + ' more ' + (moreCount === 1 ? 'reply' : 'replies');
    }
    for (var i = 1; i < entries.length - 1; i++) {
      entries[i].style.display = 'none';
      entries[i].classList.add('collapsed-entry');
    }
  }

  // ── auto-collapse on outside click ─────────
  document.addEventListener('click', function(e) {
    document.querySelectorAll('.comment-thread-block.focused').forEach(function(block) {
      if (!block.contains(e.target)) {
        collapseThread(block);
      }
    });
  });

  // ── helper: highlight a sidebar section ────
  function highlightSection(sectionEl) {
    sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sectionEl.classList.add('highlighted');
    setTimeout(() => sectionEl.classList.remove('highlighted'), 1500);
  }

  // ── helper: build a sidebar section for a slug ──
  function buildSidebarSection(slug, headingText, heading) {
    const threads = commentsBySlug[slug];

    const section = document.createElement('div');
    section.className = 'sidebar-section';
    section.id = 'sidebar-' + slug;

    const title = document.createElement('div');
    title.className = 'sidebar-section-title';
    title.textContent = headingText;

    if (threads && threads.length > 0) {
      const totalComments = threads.reduce((sum, t) => sum + t.thread.thread.length, 0);
      const countBadge = document.createElement('span');
      countBadge.className = 'section-comment-count';
      countBadge.textContent = String(totalComments);
      title.appendChild(countBadge);
    }

    // Click section title in sidebar → scroll to heading in content
    title.addEventListener('click', () => {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    section.appendChild(title);

    // Render existing comment threads
    if (threads && threads.length > 0) {
      threads.forEach(({ thread, isStale }) => {
        const status = isStale ? 'stale' : thread.status;
        const block = document.createElement('div');
        block.className = 'comment-thread-block ' + status;

        const statusLabel = document.createElement('div');
        statusLabel.className = 'thread-status-label ' + status;
        const statusText = document.createElement('span');
        const labels = { open: '\u25CF Open', resolved: '\u2713 Resolved', stale: '\u26A0 Content Changed', orphaned: '\u26A0 Section Removed' };
        statusText.textContent = (labels[status] || status) + (thread.isDraft ? '  (Draft)' : '');
        statusLabel.appendChild(statusText);

        // Thread-level thumbs-up reaction (uses first comment's reactions)
        if (thread.thread.length > 0) {
          const firstEntry = thread.thread[0];
          const threadReactions = firstEntry.reactions || [];
          const threadReactionBtn = document.createElement('button');
          threadReactionBtn.className = 'reaction-btn' + (threadReactions.includes(currentUser) ? ' reacted' : '');
          threadReactionBtn.title = threadReactions.length > 0 ? threadReactions.join(', ') : 'Add reaction';
          const threadThumbsUp = document.createElement('span');
          threadThumbsUp.textContent = '\uD83D\uDC4D';
          threadReactionBtn.appendChild(threadThumbsUp);
          if (threadReactions.length > 0) {
            const threadCount = document.createElement('span');
            threadCount.className = 'reaction-count';
            threadCount.textContent = String(threadReactions.length);
            threadReactionBtn.appendChild(threadCount);
          }
          threadReactionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'toggleReaction', threadId: thread.id, commentId: firstEntry.id });
          });
          statusLabel.appendChild(threadReactionBtn);
        }

        block.appendChild(statusLabel);

        var entryElements = [];
        thread.thread.forEach((entry, entryIndex) => {
          const entryEl = document.createElement('div');
          entryEl.className = 'comment-entry';

          const header = document.createElement('div');
          header.className = 'comment-header';

          const authorSpan = document.createElement('span');
          authorSpan.className = 'comment-author';
          authorSpan.textContent = entry.author;
          header.appendChild(authorSpan);

          const time = document.createElement('span');
          time.className = 'comment-time';
          try { time.textContent = new Date(entry.created).toLocaleString(); }
          catch (_) { time.textContent = entry.created; }
          header.appendChild(time);

          entryEl.appendChild(header);

          const body = document.createElement('div');
          body.className = 'comment-body';
          body.textContent = entry.body;
          entryEl.appendChild(body);

          // Per-comment action links (only for the comment author, and only on non-resolved threads)
          if (entry.author === currentUser && status !== 'resolved') {
            const commentActions = document.createElement('div');
            commentActions.className = 'comment-actions';

            const editLink = document.createElement('button');
            editLink.className = 'action-link';
            editLink.textContent = 'Edit';
            editLink.addEventListener('click', (e) => {
              e.stopPropagation();
              // Toggle: if edit form already open, close it
              const existing = entryEl.querySelector('.comment-form');
              if (existing) { existing.remove(); body.style.display = ''; return; }
              body.style.display = 'none';
              const { form, textarea } = createCommentForm({
                placeholder: 'Edit your comment...',
                submitLabel: 'Save',
                onSubmit: (text) => {
                  vscode.postMessage({ command: 'editComment', threadId: thread.id, commentId: entry.id, body: text });
                }
              });
              textarea.value = entry.body;
              // On cancel, restore body visibility
              const cancelBtn = form.querySelector('.btn-cancel');
              if (cancelBtn) {
                cancelBtn.addEventListener('click', () => { body.style.display = ''; });
              }
              entryEl.insertBefore(form, commentActions);
              textarea.focus();
            });
            commentActions.appendChild(editLink);

            const deleteLink = document.createElement('button');
            deleteLink.className = 'action-link';
            deleteLink.textContent = 'Delete';
            deleteLink.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ command: 'deleteComment', threadId: thread.id, commentId: entry.id });
            });
            commentActions.appendChild(deleteLink);

            entryEl.appendChild(commentActions);
          }

          entryElements.push(entryEl);
        });

        // Collapse/expand logic: show first & last, hide middle comments
        if (entryElements.length > 2) {
          block.appendChild(entryElements[0]);

          var divider = document.createElement('div');
          divider.className = 'collapsed-divider';
          var moreCount = entryElements.length - 2;
          divider.textContent = moreCount + ' more ' + (moreCount === 1 ? 'reply' : 'replies');
          divider.addEventListener('click', function(e) {
            e.stopPropagation();
            expandThread(block);
          });
          block.appendChild(divider);

          for (var i = 1; i < entryElements.length - 1; i++) {
            entryElements[i].classList.add('collapsed-entry');
            entryElements[i].style.display = 'none';
            block.appendChild(entryElements[i]);
          }

          block.appendChild(entryElements[entryElements.length - 1]);
          block.dataset.collapsible = 'true';
        } else {
          entryElements.forEach(function(el) { block.appendChild(el); });
        }

        // Auto-expand on click
        block.addEventListener('click', function() {
          if (block.dataset.collapsible === 'true' && !block.classList.contains('focused')) {
            expandThread(block);
          }
        });

        // Thread-level actions bar
        const actionsBar = document.createElement('div');
        actionsBar.className = 'thread-actions';

        // Only show Reply button on non-resolved threads
        if (status !== 'resolved') {
          const replyBtn = document.createElement('button');
          replyBtn.className = 'action-link';
          replyBtn.textContent = '\u21A9 Reply';
          replyBtn.addEventListener('click', () => {
            const existing = block.querySelector('.comment-form');
            if (existing) { existing.remove(); return; }
            const { form, textarea } = createCommentForm({
              placeholder: 'Write a reply...',
              submitLabel: 'Reply',
              onSubmit: (text) => {
                vscode.postMessage({ command: 'replyComment', threadId: thread.id, body: text });
              }
            });
            block.appendChild(form);
            textarea.focus();
          });
          actionsBar.appendChild(replyBtn);
        }

        if (status === 'open' || status === 'stale') {
          const resolveBtn = document.createElement('button');
          resolveBtn.className = 'action-link';
          resolveBtn.textContent = '\u2713 Resolve';
          resolveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'resolveThread', threadId: thread.id });
          });
          actionsBar.appendChild(resolveBtn);
        } else if (status === 'resolved') {
          const reopenBtn = document.createElement('button');
          reopenBtn.className = 'action-link';
          reopenBtn.textContent = '\u21BB Reopen';
          reopenBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'reopenThread', threadId: thread.id });
          });
          actionsBar.appendChild(reopenBtn);
        }

        // Delete Thread link — only for the thread creator, and only on non-resolved threads
        if (status !== 'resolved' && thread.thread.length > 0 && thread.thread[0].author === currentUser) {
          const deleteThreadLink = document.createElement('button');
          deleteThreadLink.className = 'action-link';
          deleteThreadLink.textContent = '\u2715 Delete Thread';
          deleteThreadLink.addEventListener('click', () => {
            vscode.postMessage({ command: 'deleteThread', threadId: thread.id });
          });
          actionsBar.appendChild(deleteThreadLink);
        }

        block.appendChild(actionsBar);
        section.appendChild(block);
      });
    }

    // "Add Comment" button in sidebar
    const sidebarAddBtn = document.createElement('button');
    sidebarAddBtn.className = 'sidebar-add-comment-btn';
    sidebarAddBtn.innerHTML = '&#x1F4AC; Add Comment';
    sidebarAddBtn.addEventListener('click', () => {
      const existing = section.querySelector('.comment-form');
      if (existing) { existing.remove(); return; }
      const { form, textarea } = createCommentForm({
        placeholder: 'Share your feedback on this section...',
        submitLabel: 'Add Comment',
        onSubmit: (text) => {
          vscode.postMessage({ command: 'addComment', slug: slug, body: text });
        }
      });
      section.appendChild(form);
      textarea.focus();
    });
    section.appendChild(sidebarAddBtn);

    return { section, sidebarAddBtn };
  }

  // ── track sidebar sections ──
  const sidebarSections = {};
  const emptyState = document.createElement('div');
  emptyState.className = 'sidebar-empty';
  emptyState.textContent = 'Click a Comment button on any section heading to start a discussion.';

  function updateEmptyState() {
    if (sidebarContent.children.length === 0 ||
        (sidebarContent.children.length === 1 && sidebarContent.contains(emptyState))) {
      if (!sidebarContent.contains(emptyState)) {
        sidebarContent.appendChild(emptyState);
      }
    } else if (sidebarContent.contains(emptyState)) {
      emptyState.remove();
    }
  }

  // ── helper: ensure a section exists in the sidebar ──
  function ensureSidebarSection(slug, headingText, heading) {
    if (sidebarSections[slug]) {
      return sidebarSections[slug];
    }
    const result = buildSidebarSection(slug, headingText, heading);
    sidebarSections[slug] = result;
    sidebarContent.appendChild(result.section);
    updateEmptyState();
    return result;
  }

  // ── process each heading ───────────────────
  document.querySelectorAll('[data-slug]').forEach(heading => {
    const slug = heading.getAttribute('data-slug');
    const headingText = heading.textContent.trim();
    const threads = commentsBySlug[slug];
    const hasComments = threads && threads.length > 0;

    // Only add to sidebar immediately if the section has existing comments
    if (hasComments) {
      const totalComments = threads.reduce((sum, t) => sum + t.thread.thread.length, 0);
      const result = ensureSidebarSection(slug, headingText, heading);

      // Badge on the heading showing comment count → scrolls to sidebar
      const badge = document.createElement('button');
      badge.className = 'comment-badge';
      badge.textContent = totalComments + ' comment' + (totalComments !== 1 ? 's' : '');
      badge.title = 'View comments in sidebar';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightSection(result.section);
      });
      heading.appendChild(badge);
    }

    // "Comment" button on every heading → adds section to sidebar & opens form
    const headingAddBtn = document.createElement('button');
    headingAddBtn.className = 'add-comment-btn';
    headingAddBtn.innerHTML = '&#x1F4AC;';
    headingAddBtn.title = 'Add a comment on this section';
    headingAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const result = ensureSidebarSection(slug, headingText, heading);
      highlightSection(result.section);
      // Auto-open comment form after scroll
      setTimeout(() => {
        if (!result.section.querySelector('.comment-form')) {
          result.sidebarAddBtn.click();
        }
      }, 400);
    });
    heading.appendChild(headingAddBtn);
  });

  // ── render orphaned threads (section no longer exists) ──
  (function renderOrphanedThreads() {
    // Collect slugs that have a [data-slug] heading in the document
    const existingSlugs = new Set();
    document.querySelectorAll('[data-slug]').forEach(el => {
      existingSlugs.add(el.getAttribute('data-slug'));
    });

    // Find slugs in commentsBySlug that don't have a corresponding heading
    const orphanedSlugs = Object.keys(commentsBySlug).filter(slug => !existingSlugs.has(slug));
    if (orphanedSlugs.length === 0) { return; }

    // Create orphaned section container
    const orphanedSection = document.createElement('div');
    orphanedSection.className = 'sidebar-section orphaned-section';
    orphanedSection.id = 'sidebar-orphaned';

    const orphanedTitle = document.createElement('div');
    orphanedTitle.className = 'sidebar-section-title orphaned-section-title';
    orphanedTitle.textContent = 'Orphaned Comments';

    // Count total orphaned comments
    let totalOrphanedComments = 0;
    orphanedSlugs.forEach(slug => {
      const threads = commentsBySlug[slug];
      if (threads) {
        totalOrphanedComments += threads.reduce((sum, t) => sum + t.thread.thread.length, 0);
      }
    });

    const countBadge = document.createElement('span');
    countBadge.className = 'section-comment-count';
    countBadge.textContent = String(totalOrphanedComments);
    orphanedTitle.appendChild(countBadge);

    orphanedSection.appendChild(orphanedTitle);

    // Render each orphaned thread
    orphanedSlugs.forEach(slug => {
      const threads = commentsBySlug[slug];
      if (!threads) { return; }

      threads.forEach(({ thread, reparentCandidate }) => {
        const status = 'orphaned';
        const block = document.createElement('div');
        block.className = 'comment-thread-block ' + status;

        const statusLabel = document.createElement('div');
        statusLabel.className = 'thread-status-label ' + status;
        const statusText = document.createElement('span');
        const labels = { orphaned: '\u26A0 Section Removed' };
        statusText.textContent = (labels[status] || status) + (thread.isDraft ? '  (Draft)' : '');
        statusLabel.appendChild(statusText);

        // Thread-level thumbs-up reaction for orphaned thread (read-only)
        if (thread.thread.length > 0) {
          const firstEntry = thread.thread[0];
          const threadReactions = firstEntry.reactions || [];
          if (threadReactions.length > 0) {
            const threadReactionBtn = document.createElement('button');
            threadReactionBtn.className = 'reaction-btn' + (threadReactions.includes(currentUser) ? ' reacted' : '');
            threadReactionBtn.title = threadReactions.join(', ');
            threadReactionBtn.disabled = true;
            const threadThumbsUp = document.createElement('span');
            threadThumbsUp.textContent = '\uD83D\uDC4D';
            threadReactionBtn.appendChild(threadThumbsUp);
            const threadCount = document.createElement('span');
            threadCount.className = 'reaction-count';
            threadCount.textContent = String(threadReactions.length);
            threadReactionBtn.appendChild(threadCount);
            statusLabel.appendChild(threadReactionBtn);
          }
        }

        // Show original section slug as reference
        const slugRef = document.createElement('div');
        slugRef.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;';
        slugRef.textContent = 'Was: #' + slug;
        block.appendChild(statusLabel);
        block.appendChild(slugRef);

        // Reparent UI: show auto-match button or dropdown
        if (reparentCandidate) {
          const reparentBar = document.createElement('div');
          reparentBar.className = 'reparent-bar';
          const reparentBtn = document.createElement('button');
          reparentBtn.className = 'reparent-btn';
          reparentBtn.innerHTML = '\uD83D\uDD17 Reparent to: <strong>' + reparentCandidate.heading + '</strong>';
          reparentBtn.title = 'Move this thread to the section "' + reparentCandidate.heading + '"';
          reparentBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'reparentThread', threadId: thread.id, newSlug: reparentCandidate.slug });
          });
          reparentBar.appendChild(reparentBtn);
          block.appendChild(reparentBar);
        } else if (allSections.length > 0) {
          // Manual reparent dropdown
          const reparentBar = document.createElement('div');
          reparentBar.className = 'reparent-bar';
          const reparentLabel = document.createElement('span');
          reparentLabel.textContent = '\uD83D\uDD17 Reparent to: ';
          reparentLabel.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground);';
          reparentBar.appendChild(reparentLabel);
          const reparentSelect = document.createElement('select');
          reparentSelect.className = 'reparent-select';
          const defaultOpt = document.createElement('option');
          defaultOpt.value = '';
          defaultOpt.textContent = '— Select section —';
          reparentSelect.appendChild(defaultOpt);
          allSections.forEach(sec => {
            const opt = document.createElement('option');
            opt.value = sec.slug;
            opt.textContent = sec.heading;
            reparentSelect.appendChild(opt);
          });
          reparentSelect.addEventListener('change', () => {
            if (reparentSelect.value) {
              vscode.postMessage({ command: 'reparentThread', threadId: thread.id, newSlug: reparentSelect.value });
            }
          });
          reparentBar.appendChild(reparentSelect);
          block.appendChild(reparentBar);
        }

        var orphanedEntryElements = [];
        thread.thread.forEach((entry, entryIndex) => {
          const entryEl = document.createElement('div');
          entryEl.className = 'comment-entry';

          const header = document.createElement('div');
          header.className = 'comment-header';

          const authorSpan = document.createElement('span');
          authorSpan.className = 'comment-author';
          authorSpan.textContent = entry.author;
          header.appendChild(authorSpan);

          const time = document.createElement('span');
          time.className = 'comment-time';
          try { time.textContent = new Date(entry.created).toLocaleString(); }
          catch (_) { time.textContent = entry.created; }
          header.appendChild(time);

          entryEl.appendChild(header);

          const body = document.createElement('div');
          body.className = 'comment-body';
          body.textContent = entry.body;
          entryEl.appendChild(body);

          orphanedEntryElements.push(entryEl);
        });

        // Collapse/expand for orphaned threads
        if (orphanedEntryElements.length > 2) {
          block.appendChild(orphanedEntryElements[0]);

          var orphanedDivider = document.createElement('div');
          orphanedDivider.className = 'collapsed-divider';
          var orphanedMoreCount = orphanedEntryElements.length - 2;
          orphanedDivider.textContent = orphanedMoreCount + ' more ' + (orphanedMoreCount === 1 ? 'reply' : 'replies');
          orphanedDivider.addEventListener('click', function(e) {
            e.stopPropagation();
            expandThread(block);
          });
          block.appendChild(orphanedDivider);

          for (var oi = 1; oi < orphanedEntryElements.length - 1; oi++) {
            orphanedEntryElements[oi].classList.add('collapsed-entry');
            orphanedEntryElements[oi].style.display = 'none';
            block.appendChild(orphanedEntryElements[oi]);
          }

          block.appendChild(orphanedEntryElements[orphanedEntryElements.length - 1]);
          block.dataset.collapsible = 'true';
        } else {
          orphanedEntryElements.forEach(function(el) { block.appendChild(el); });
        }

        // Auto-expand on click
        block.addEventListener('click', function() {
          if (block.dataset.collapsible === 'true' && !block.classList.contains('focused')) {
            expandThread(block);
          }
        });

        // Actions bar (no reply for orphaned, but allow resolve/delete)
        const actionsBar = document.createElement('div');
        actionsBar.className = 'thread-actions';

        if (thread.status !== 'resolved') {
          const resolveBtn = document.createElement('button');
          resolveBtn.className = 'action-link';
          resolveBtn.textContent = '\u2713 Resolve';
          resolveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'resolveThread', threadId: thread.id });
          });
          actionsBar.appendChild(resolveBtn);
        } else {
          const reopenBtn = document.createElement('button');
          reopenBtn.className = 'action-link';
          reopenBtn.textContent = '\u21BB Reopen';
          reopenBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'reopenThread', threadId: thread.id });
          });
          actionsBar.appendChild(reopenBtn);
        }

        // Delete Thread link — only for the thread creator
        if (thread.thread.length > 0 && thread.thread[0].author === currentUser) {
          const deleteThreadLink = document.createElement('button');
          deleteThreadLink.className = 'action-link';
          deleteThreadLink.textContent = '\u2715 Delete Thread';
          deleteThreadLink.addEventListener('click', () => {
            vscode.postMessage({ command: 'deleteThread', threadId: thread.id });
          });
          actionsBar.appendChild(deleteThreadLink);
        }

        block.appendChild(actionsBar);
        orphanedSection.appendChild(block);
      });
    });

    sidebarContent.appendChild(orphanedSection);
  })();

  updateEmptyState();

  // ── thread count badge ─────────────────────
  (function updateThreadCount() {
    const badge = document.getElementById('thread-count-badge');
    if (!badge) { return; }
    let threadCount = 0;
    for (const slug in commentsBySlug) {
      const threads = commentsBySlug[slug];
      if (threads) { threadCount += threads.length; }
    }
    badge.textContent = String(threadCount);
    if (threadCount === 0) { badge.style.display = 'none'; }
  })();

  // ── publish button ─────────────────────────
  (function renderPublishButton() {
    const btn = document.getElementById('publish-btn');
    if (!btn) { return; }
    let draftCount = 0;
    for (const slug in commentsBySlug) {
      const threads = commentsBySlug[slug];
      if (!threads) { continue; }
      for (const t of threads) {
        if (t.thread.isDraft) { draftCount++; }
      }
    }
    if (draftCount > 0) {
      btn.style.display = '';
      btn.textContent = 'Publish ' + draftCount + ' draft' + (draftCount > 1 ? 's' : '');
    } else {
      btn.style.display = 'none';
    }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Publishing\u2026';
      vscode.postMessage({ command: 'publishDrafts' });
    });
  })();

  // ── statistics chart ───────────────────────
  (function renderStats() {
    const statsEl = document.getElementById('sidebar-stats');
    if (!statsEl) { return; }

    // Collect existing slugs to identify orphaned threads
    const existingSlugs = new Set();
    document.querySelectorAll('[data-slug]').forEach(el => {
      existingSlugs.add(el.getAttribute('data-slug'));
    });

    let openCount = 0;
    let resolvedCount = 0;
    let orphanedCount = 0;
    for (const slug in commentsBySlug) {
      const threads = commentsBySlug[slug];
      if (!threads) { continue; }
      const isOrphanedSlug = !existingSlugs.has(slug);
      for (const t of threads) {
        if (isOrphanedSlug) {
          orphanedCount++;
        } else if (t.thread.status === 'resolved') {
          resolvedCount++;
        } else {
          openCount++;
        }
      }
    }
    const total = openCount + resolvedCount + orphanedCount;
    if (total === 0) { statsEl.style.display = 'none'; return; }
    statsEl.style.display = '';
    const openPct = Math.round((openCount / total) * 100);
    const resolvedPct = Math.round((resolvedCount / total) * 100);
    const orphanedPct = 100 - openPct - resolvedPct;
    let barHtml = '<div class="stats-bar-container">';
    if (openPct > 0) { barHtml += '<div class="stats-bar-open" style="width:' + openPct + '%"></div>'; }
    if (resolvedPct > 0) { barHtml += '<div class="stats-bar-resolved" style="width:' + resolvedPct + '%"></div>'; }
    if (orphanedPct > 0) { barHtml += '<div class="stats-bar-orphaned" style="width:' + orphanedPct + '%"></div>'; }
    barHtml += '</div>';
    let legendHtml = '<div class="stats-legend">';
    legendHtml += '<div class="stats-legend-item"><span class="stats-dot stats-dot-open"></span> Open <span class="stats-count">' + openCount + '</span></div>';
    legendHtml += '<div class="stats-legend-item"><span class="stats-dot stats-dot-resolved"></span> Resolved <span class="stats-count">' + resolvedCount + '</span></div>';
    if (orphanedCount > 0) {
      legendHtml += '<div class="stats-legend-item"><span class="stats-dot stats-dot-orphaned"></span> Orphaned <span class="stats-count">' + orphanedCount + '</span></div>';
    }
    legendHtml += '</div>';
    statsEl.innerHTML = '<div class="stats-title">Thread Summary</div>' + barHtml + legendHtml;
  })();

})();
`;
