import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { simpleGit, SimpleGit } from 'simple-git';
import type { ProviderInfo } from './models/types';
import { authManager } from './auth/authManager';

/**
 * Git operations service
 */
export class GitService {
  private git: SimpleGit | null = null;

  /**
   * Initialize git for the workspace
   */
  async initialize(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.log('[MarkdownThreads] gitService.initialize: no workspace folder');
      return false;
    }

    console.log('[MarkdownThreads] gitService.initialize: folder =', workspaceFolder.uri.fsPath);
    this.git = simpleGit(workspaceFolder.uri.fsPath);
    
    try {
      const isRepo = await this.git.checkIsRepo();
      console.log('[MarkdownThreads] gitService.initialize: isRepo =', isRepo);
      if (!isRepo) {
        this.git = null;
      }
      return isRepo;
    } catch (err) {
      console.log('[MarkdownThreads] gitService.initialize: error', err);
      this.git = null;
      return false;
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(): Promise<string | null> {
    if (!this.git) {
      return null;
    }

    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get the remote URL for origin
   */
  async getRemoteUrl(): Promise<string | null> {
    if (!this.git) {
      return null;
    }

    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      return origin?.refs.fetch ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Detect provider info from remote
   */
  async detectProvider(): Promise<ProviderInfo | null> {
    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) {
      return null;
    }
    return authManager.parseRemoteUrl(remoteUrl);
  }

  /**
   * Get git user display name (user.name), falling back to user.email
   */
  async getUserName(): Promise<string> {
    // Lazy-init if git wasn't ready at startup
    if (!this.git) {
      console.log('[MarkdownThreads] getUserName: git not initialized, retrying...');
      await this.initialize();
    }

    // Try via simpleGit first
    if (this.git) {
      try {
        const name = await this.git.raw(['config', 'user.name']);
        if (name.trim()) {
          return name.trim();
        }
      } catch {
        // fall through
      }
      try {
        const email = await this.git.raw(['config', 'user.email']);
        if (email.trim()) {
          return email.trim();
        }
      } catch {
        // fall through
      }
    }

    // Fallback: shell out to git directly (works even without a workspace folder)
    console.log('[MarkdownThreads] getUserName: falling back to execSync');
    try {
      const name = execSync('git config --global user.name', { encoding: 'utf8' }).trim();
      if (name) { return name; }
    } catch { /* ignore */ }
    try {
      const email = execSync('git config --global user.email', { encoding: 'utf8' }).trim();
      if (email) { return email; }
    } catch { /* ignore */ }

    return 'Unknown';
  }

  /**
   * Get git user email
   */
  async getUserEmail(): Promise<string> {
    if (!this.git) {
      return 'unknown@unknown.com';
    }

    try {
      const email = await this.git.raw(['config', 'user.email']);
      return email.trim() || 'unknown@unknown.com';
    } catch {
      return 'unknown@unknown.com';
    }
  }

  /**
   * Create a new branch for comments
   */
  async createCommentBranch(docName: string): Promise<string | null> {
    if (!this.git) {
      return null;
    }

    // Check for uncommitted changes before branching
    try {
      const status = await this.git.status();
      const isSidecar = (f: string) => f.endsWith('.comments.json');
      const nonSidecarModified = status.modified.filter(f => !isSidecar(f));
      const nonSidecarStaged = status.staged.filter(f => !isSidecar(f));
      const nonSidecarUntracked = status.not_added.filter(f => !isSidecar(f));
      if (nonSidecarModified.length > 0 || nonSidecarStaged.length > 0 || nonSidecarUntracked.length > 0) {
        vscode.window.showErrorMessage(
          'You have uncommitted changes. Please commit or stash them before publishing comments.'
        );
        return null;
      }
    } catch {
      // If status check fails, proceed anyway
    }

    const config = vscode.workspace.getConfiguration('markdownThreads');
    const prefix = config.get<string>('branchPrefix', 'doc-comment');
    
    const email = await this.getUserEmail();
    const user = email.split('@')[0];
    const date = new Date().toISOString().split('T')[0];
    const docSlug = docName.replace(/\.md$/, '').replace(/[^a-zA-Z0-9]/g, '-');
    const suffix = crypto.randomBytes(2).toString('hex');
    
    const branchName = `${prefix}/${docSlug}-${user}-${date}-${suffix}`;

    try {
      // Create and checkout new branch
      await this.git.checkoutLocalBranch(branchName);
      
      return branchName;
    } catch (error) {
      console.error('Failed to create branch:', error);
      return null;
    }
  }

  /**
   * Stage and commit sidecar file changes
   */
  async commitSidecarChanges(sidecarPath: string, docName: string): Promise<boolean> {
    if (!this.git) {
      return false;
    }

    try {
      await this.git.add(sidecarPath);
      await this.git.commit(`Add design feedback for ${docName}`);
      return true;
    } catch (error) {
      console.error('Failed to commit changes:', error);
      return false;
    }
  }

  /**
   * Push branch to remote
   */
  async pushBranch(branchName: string): Promise<boolean> {
    if (!this.git) {
      return false;
    }

    try {
      await this.git.push('origin', branchName, ['--set-upstream']);
      return true;
    } catch (error) {
      console.error('Failed to push branch:', error);
      return false;
    }
  }

  /**
   * Get default branch name
   */
  async getDefaultBranch(): Promise<string> {
    if (!this.git) {
      return 'main';
    }

    try {
      const result = await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
      return result.trim().replace('origin/', '') || 'main';
    } catch {
      // Fallback: inspect remote branches to find the default
      try {
        const branches = await this.git.branch(['-r']);
        if (branches.all.includes('origin/main')) {
          return 'main';
        }
        if (branches.all.includes('origin/master')) {
          return 'master';
        }
        // Use the first remote branch as a last resort
        const first = branches.all.find(b => b.startsWith('origin/'));
        return first ? first.replace('origin/', '') : 'main';
      } catch {
        return 'main';
      }
    }
  }

  /**
   * Return to the original branch
   */
  async checkoutBranch(branchName: string): Promise<boolean> {
    if (!this.git) {
      return false;
    }

    try {
      await this.git.checkout(branchName);
      return true;
    } catch {
      return false;
    }
  }
}

export const gitService = new GitService();
