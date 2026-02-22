import * as vscode from 'vscode';
import * as path from 'path';
import { sidecarManager } from './sidecarManager';
import { gitService } from './gitService';
import { gitHubProvider } from './providers/githubProvider';
import { adoProvider } from './providers/adoProvider';
import { PreviewPanel } from './previewPanel';
import { MarkdownFilesProvider } from './markdownFilesProvider';

let statusBarItem: vscode.StatusBarItem;
let markdownFilesProvider: MarkdownFilesProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[MarkdownThreads] Extension activating...');
  console.log('[MarkdownThreads] Workspace folders:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));

  // Set extension URI for PreviewPanel to locate bundled resources (e.g., mermaid.js)
  PreviewPanel.setExtensionUri(context.extensionUri);

  // Create and register the tree view for markdown files
  markdownFilesProvider = new MarkdownFilesProvider();
  const treeView = vscode.window.createTreeView('markdownThreads.files', {
    treeDataProvider: markdownFilesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push({ dispose: () => markdownFilesProvider.dispose() });

  // Update tree view description when folder selection changes
  markdownFilesProvider.onDidChangeTreeData(() => {
    treeView.description = markdownFilesProvider.getSelectedFolderName();
  });

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'markdownThreads.publishDrafts';
  context.subscriptions.push(statusBarItem);

  // Register commands FIRST so they are available even if git init fails
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownThreads.publishDrafts', handlePublishDrafts),
    vscode.commands.registerCommand('markdownThreads.refreshFiles', () => markdownFilesProvider.refresh()),
    vscode.commands.registerCommand('markdownThreads.selectFolder', () => markdownFilesProvider.selectFolder()),
    vscode.commands.registerCommand('markdownThreads.openPreview', async (uri?: vscode.Uri) => {
      let document: vscode.TextDocument | undefined;
      if (uri) {
        // Invoked from explorer context menu — load document without opening an editor
        document = await vscode.workspace.openTextDocument(uri);
        // Show preview panel first
        await PreviewPanel.show(document);
        // Close any editor tab the explorer may have opened for this file
        for (const tabGroup of vscode.window.tabGroups.all) {
          for (const tab of tabGroup.tabs) {
            const tabUri = (tab.input as { uri?: vscode.Uri })?.uri;
            if (tabUri && tabUri.toString() === uri.toString()) {
              await vscode.window.tabGroups.close(tab);
            }
          }
        }
        return;
      } else {
        // Invoked from command palette or editor title
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'markdown') {
          document = editor.document;
        }
      }
      if (!document || document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Open a markdown file to preview with comments');
        return;
      }
      await PreviewPanel.show(document);
    })
  );

  // Register event handlers
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async () => {
      await updateStatusBar();
    }),
    vscode.workspace.onDidSaveTextDocument(async () => {
      await updateStatusBar();
    })
  );

  // Initialize git service (after commands are registered to avoid blocking activation)
  try {
    await gitService.initialize();
  } catch (err) {
    console.error('[MarkdownThreads] Git initialization failed:', err);
  }

  // Update status bar for current editor
  await updateStatusBar();
}

async function handlePublishDrafts(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('Open a markdown file to publish comments');
    return;
  }

  const document = editor.document;
  const sidecar = await sidecarManager.readSidecar(document.uri.fsPath);
  
  if (!sidecar) {
    vscode.window.showInformationMessage('No comments to publish');
    return;
  }

  const draftThreads = sidecarManager.getDraftThreads(sidecar);
  if (draftThreads.length === 0) {
    vscode.window.showInformationMessage('No draft comments to publish');
    return;
  }

  // Detect provider — respect defaultProvider config setting
  const config = vscode.workspace.getConfiguration('markdownThreads');
  const defaultProvider = config.get<string>('defaultProvider', 'auto');

  let providerInfo = await gitService.detectProvider();

  if (defaultProvider !== 'auto' && providerInfo) {
    // Override the auto-detected provider with the user's explicit choice
    providerInfo = { ...providerInfo, provider: defaultProvider as 'github' | 'azuredevops' };
  }

  if (!providerInfo) {
    vscode.window.showErrorMessage('Could not detect git provider. Make sure you have a remote configured.');
    return;
  }

  const docName = path.basename(document.uri.fsPath);

  // Create branch
  const currentBranch = await gitService.getCurrentBranch();
  const branchName = await gitService.createCommentBranch(docName);
  
  if (!branchName) {
    vscode.window.showErrorMessage('Failed to create branch for comments');
    return;
  }

  // Mark drafts as published
  sidecarManager.markAllPublished(sidecar);
  await sidecarManager.writeSidecar(document.uri.fsPath, sidecar, 'internal');

  // Commit changes
  const sidecarPath = sidecarManager.getSidecarPath(document.uri.fsPath);
  const committed = await gitService.commitSidecarChanges(sidecarPath, docName);
  
  if (!committed) {
    vscode.window.showErrorMessage('Failed to commit changes');
    if (currentBranch) {
      await gitService.checkoutBranch(currentBranch);
    }
    return;
  }

  // Push branch
  const pushed = await gitService.pushBranch(branchName);
  if (!pushed) {
    vscode.window.showErrorMessage('Failed to push branch');
    if (currentBranch) {
      await gitService.checkoutBranch(currentBranch);
    }
    return;
  }

  // Create PR
  const baseBranch = await gitService.getDefaultBranch();
  const title = `Feedback on ${docName}`;
  const body = `This PR contains ${draftThreads.length} comment thread(s) on ${docName}.\n\nCreated by Markdown Threads extension.`;

  let result;
  if (providerInfo.provider === 'github') {
    result = await gitHubProvider.createPullRequest(providerInfo, branchName, baseBranch, title, body);
  } else if (providerInfo.provider === 'azuredevops') {
    result = await adoProvider.createPullRequest(providerInfo, branchName, baseBranch, title, body);
  } else {
    vscode.window.showErrorMessage('Unsupported git provider');
    if (currentBranch) {
      await gitService.checkoutBranch(currentBranch);
    }
    return;
  }

  // Return to original branch
  if (currentBranch) {
    await gitService.checkoutBranch(currentBranch);
  }

  if (result.success && result.prUrl) {
    const autoOpen = config.get<boolean>('autoOpenPR', true);
    
    if (autoOpen) {
      vscode.env.openExternal(vscode.Uri.parse(result.prUrl));
    }
    
    vscode.window.showInformationMessage(`PR created: ${result.prUrl}`);
  } else {
    vscode.window.showErrorMessage(`Failed to create PR: ${result.error}`);
  }

  await updateStatusBar();
}

async function updateStatusBar(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    statusBarItem.hide();
    return;
  }

  const sidecar = await sidecarManager.readSidecar(editor.document.uri.fsPath);
  if (!sidecar) {
    statusBarItem.hide();
    return;
  }

  const draftCount = sidecarManager.getDraftThreads(sidecar).length;
  
  if (draftCount > 0) {
    statusBarItem.text = `$(comment-discussion) ${draftCount} draft comment${draftCount > 1 ? 's' : ''}`;
    statusBarItem.tooltip = 'Click to publish comments as PR';
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
