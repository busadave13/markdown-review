import * as vscode from 'vscode';
import * as path from 'path';
import { sidecarManager } from './sidecarManager';

/**
 * Represents a markdown file in the tree view.
 */
export class MarkdownFileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly uri: vscode.Uri,
    public readonly commentCount: number,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.resourceUri = uri;
    this.tooltip = uri.fsPath;
    this.contextValue = 'markdownFile';

    // Click action opens preview
    this.command = {
      command: 'markdownThreads.openPreview',
      title: 'Open Preview',
      arguments: [uri],
    };

    // Show comment count as description
    if (commentCount > 0) {
      this.description = `${commentCount} comment${commentCount > 1 ? 's' : ''}`;
    }

    // Use markdown icon
    this.iconPath = new vscode.ThemeIcon('markdown');
  }
}

/**
 * Represents a folder containing markdown files.
 */
export class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly folderPath: string,
    public readonly children: (MarkdownFileItem | FolderItem)[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'folder';
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

type TreeItem = MarkdownFileItem | FolderItem;

/**
 * Provides markdown files for the sidebar tree view.
 */
export class MarkdownFilesProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private sidecarWatcher: vscode.FileSystemWatcher | undefined;
  private selectedFolder: string | undefined; // undefined = show all folders

  constructor() {
    // Watch for markdown file changes
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    this.fileWatcher.onDidCreate(() => this.refresh());
    this.fileWatcher.onDidDelete(() => this.refresh());
    this.fileWatcher.onDidChange(() => this.refresh());

    // Watch for sidecar file changes (comment count updates)
    this.sidecarWatcher = vscode.workspace.createFileSystemWatcher('**/*.comments.json');
    this.sidecarWatcher.onDidCreate(() => this.refresh());
    this.sidecarWatcher.onDidDelete(() => this.refresh());
    this.sidecarWatcher.onDidChange(() => this.refresh());
  }

  /**
   * Shows a QuickPick to select a folder to filter markdown files.
   */
  async selectFolder(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    // Find all directories containing markdown files
    const mdFiles = await vscode.workspace.findFiles('**/*.md');
    const folders = new Set<string>();
    folders.add(''); // Root option (show all)

    for (const file of mdFiles) {
      const relativePath = path.relative(workspaceRoot, file.fsPath);
      const dir = path.dirname(relativePath);
      if (dir !== '.') {
        // Add all parent directories
        const parts = dir.split(path.sep);
        let current = '';
        for (const part of parts) {
          current = current ? path.join(current, part) : part;
          folders.add(current);
        }
      }
    }

    // Build QuickPick items
    const items: vscode.QuickPickItem[] = [
      { label: '$(home) All Folders', description: 'Show all markdown files', detail: '' },
    ];

    const sortedFolders = Array.from(folders).filter(f => f !== '').sort();
    for (const folder of sortedFolders) {
      items.push({
        label: `$(folder) ${folder}`,
        description: '',
        detail: folder,
      });
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a folder to filter markdown files',
      title: 'Filter by Folder',
    });

    if (selected) {
      this.selectedFolder = selected.detail || undefined;
      this.refresh();
    }
  }

  /**
   * Gets the currently selected folder name for display.
   */
  getSelectedFolderName(): string {
    return this.selectedFolder || 'All Folders';
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (element instanceof FolderItem) {
      return element.children;
    }

    if (element) {
      return [];
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    // Build search pattern based on selected folder
    const searchPattern = this.selectedFolder
      ? `${this.selectedFolder}/**/*.md`
      : '**/*.md';

    // Find markdown files (filtered by folder if selected)
    let mdFiles = await vscode.workspace.findFiles(searchPattern);

    // If a folder is selected, also filter to ensure files are within that folder
    if (this.selectedFolder) {
      const selectedPath = path.join(workspaceRoot, this.selectedFolder);
      mdFiles = mdFiles.filter(uri => uri.fsPath.startsWith(selectedPath));
    }

    if (mdFiles.length === 0) {
      return [];
    }

    // Build tree structure grouped by folder
    const tree = await this.buildTree(mdFiles);
    return tree;
  }

  private async buildTree(files: vscode.Uri[]): Promise<TreeItem[]> {
    // Group files by their relative directory
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const folderMap = new Map<string, vscode.Uri[]>();

    for (const file of files) {
      const relativePath = path.relative(workspaceRoot, file.fsPath);
      const dir = path.dirname(relativePath);
      const folder = dir === '.' ? '' : dir;

      if (!folderMap.has(folder)) {
        folderMap.set(folder, []);
      }
      folderMap.get(folder)!.push(file);
    }

    // Sort folders
    const sortedFolders = Array.from(folderMap.keys()).sort();

    const result: TreeItem[] = [];

    for (const folder of sortedFolders) {
      const folderFiles = folderMap.get(folder)!;

      // Sort files by name
      folderFiles.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));

      // Create file items
      const fileItems: MarkdownFileItem[] = [];
      for (const file of folderFiles) {
        const commentCount = await this.getCommentCount(file.fsPath);
        fileItems.push(new MarkdownFileItem(path.basename(file.fsPath), file, commentCount));
      }

      if (folder === '') {
        // Root-level files
        result.push(...fileItems);
      } else {
        // Files in a subfolder
        result.push(new FolderItem(folder, path.join(workspaceRoot, folder), fileItems));
      }
    }

    return result;
  }

  private async getCommentCount(filePath: string): Promise<number> {
    const sidecar = await sidecarManager.readSidecar(filePath);
    return sidecar?.comments.length ?? 0;
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.sidecarWatcher?.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
