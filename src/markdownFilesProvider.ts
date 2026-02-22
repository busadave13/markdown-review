import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
      command: 'markdownReview.openPreview',
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

    // Get ignored directory patterns from .gitignore and .vscodeignore
    const ignoredPatterns = await this.getIgnoredPatterns();

    // Root level: find all markdown files
    let mdFiles = await vscode.workspace.findFiles('**/*.md');

    // Filter out files matching ignored patterns
    mdFiles = mdFiles.filter(uri => !this.isIgnored(uri.fsPath, ignoredPatterns));

    if (mdFiles.length === 0) {
      return [];
    }

    // Build tree structure grouped by folder
    const tree = await this.buildTree(mdFiles);
    return tree;
  }

  /**
   * Checks if a file path matches any ignored pattern.
   */
  private isIgnored(filePath: string, patterns: string[]): boolean {
    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of patterns) {
      // Convert glob pattern to a simple check
      // Handle patterns like **/node_modules/**, **/.vscode-test/**, etc.
      const dirMatch = pattern.match(/^\*\*\/(.+)\/\*\*$/);
      if (dirMatch) {
        const dirName = dirMatch[1];
        if (normalizedPath.includes(`/${dirName}/`)) {
          return true;
        }
      }

      // Handle patterns like **/*.vsix, **/*.map
      const extMatch = pattern.match(/^\*\*\/\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const ext = extMatch[1];
        if (normalizedPath.endsWith(ext)) {
          return true;
        }
      }

      // Handle simple directory patterns like **/out/**
      if (pattern.includes('/') && !pattern.includes('*')) {
        const cleanPattern = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
        if (normalizedPath.includes(`/${cleanPattern}/`)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Gets ignored patterns from .gitignore and .vscodeignore files.
   */
  private async getIgnoredPatterns(): Promise<string[]> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return [];
    }

    const patterns: string[] = [];

    // Read .gitignore
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    patterns.push(...this.parseIgnoreFile(gitignorePath));

    // Read .vscodeignore
    const vscodeignorePath = path.join(workspaceRoot, '.vscodeignore');
    patterns.push(...this.parseIgnoreFile(vscodeignorePath));

    return patterns;
  }

  /**
   * Parses an ignore file and returns glob patterns suitable for VS Code findFiles.
   */
  private parseIgnoreFile(filePath: string): string[] {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const patterns: string[] = [];

      for (let line of lines) {
        // Trim whitespace
        line = line.trim();

        // Skip empty lines and comments
        if (!line || line.startsWith('#')) {
          continue;
        }

        // Skip negation patterns (not supported in simple glob exclude)
        if (line.startsWith('!')) {
          continue;
        }

        // Convert gitignore patterns to glob patterns
        let pattern = line;

        // Track if this was explicitly a directory pattern (ends with /)
        const isDirectory = pattern.endsWith('/');

        // Remove trailing slashes (directories)
        if (isDirectory) {
          pattern = pattern.slice(0, -1);
        }

        // If pattern doesn't start with ** or /, make it match anywhere
        if (!pattern.startsWith('**/') && !pattern.startsWith('/')) {
          pattern = `**/${pattern}`;
        }

        // Remove leading / (root-relative in gitignore)
        if (pattern.startsWith('/')) {
          pattern = pattern.slice(1);
        }

        // Add /** suffix for directory patterns to match contents
        // Directory patterns: ended with /, or no file extension and no glob wildcards
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(pattern);
        if (isDirectory || (!pattern.endsWith('/**') && !hasExtension && !pattern.includes('*'))) {
          pattern = `${pattern}/**`;
        }

        patterns.push(pattern);
      }

      return patterns;
    } catch {
      return [];
    }
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
