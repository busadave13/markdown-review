import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SidecarFile, CommentThread, CommentEntry } from './models/types';
import { v4 as uuidv4 } from 'uuid';

/** Origin tag so listeners can ignore their own writes. */
export type WriteOrigin = 'editor' | 'preview' | 'internal';

export interface SidecarChangeEvent {
  /** Absolute path of the markdown document the sidecar belongs to. */
  docPath: string;
  /** Who triggered the write. */
  origin: WriteOrigin;
}

/**
 * Manages reading and writing of sidecar .comments.json files
 */
export class SidecarManager {
  /** True while we are writing a sidecar file ourselves (to suppress watcher reloads). */
  writing = false;

  private readonly _onDidChange = new vscode.EventEmitter<SidecarChangeEvent>();
  /** Fired after every successful sidecar write. */
  public readonly onDidChange: vscode.Event<SidecarChangeEvent> = this._onDidChange.event;

  /**
   * Get the sidecar file path for a markdown document
   */
  getSidecarPath(docPath: string): string {
    const dir = path.dirname(docPath);
    const base = path.basename(docPath, '.md');
    return path.join(dir, `${base}.comments.json`);
  }

  /**
   * Check if a sidecar file exists
   */
  sidecarExists(docPath: string): boolean {
    return fs.existsSync(this.getSidecarPath(docPath));
  }

  /**
   * Read and parse a sidecar file
   */
  async readSidecar(docPath: string): Promise<SidecarFile | null> {
    const sidecarPath = this.getSidecarPath(docPath);
    
    if (!fs.existsSync(sidecarPath)) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(sidecarPath, 'utf-8');
      const data = JSON.parse(content) as SidecarFile;
      return this.validateSidecar(data) ? data : null;
    } catch (error) {
      console.error(`Failed to read sidecar file: ${sidecarPath}`, error);
      return null;
    }
  }

  /**
   * Write a sidecar file atomically.
   * @param origin  Who is triggering the write (so listeners can skip their own changes).
   */
  async writeSidecar(docPath: string, sidecar: SidecarFile, origin: WriteOrigin = 'internal'): Promise<void> {
    const sidecarPath = this.getSidecarPath(docPath);
    const tempPath = `${sidecarPath}.tmp`;

    this.writing = true;
    try {
      const content = JSON.stringify(sidecar, null, 2);
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, sidecarPath);
    } catch (error) {
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
      throw error;
    } finally {
      // Reset after a short delay so the file-system watcher event has time to fire
      setTimeout(() => { this.writing = false; }, 500);
    }

    // Notify all listeners
    this._onDidChange.fire({ docPath, origin });
  }

  /**
   * Create a new empty sidecar file
   */
  createEmptySidecar(docName: string): SidecarFile {
    return {
      doc: docName,
      version: '1.0',
      comments: [],
    };
  }

  /**
   * Add a new comment thread to a sidecar
   */
  addThread(sidecar: SidecarFile, thread: Omit<CommentThread, 'id'>): CommentThread {
    const newThread: CommentThread = {
      ...thread,
      id: uuidv4(),
    };
    sidecar.comments.push(newThread);
    return newThread;
  }

  /**
   * Add a reply to an existing thread
   */
  addReply(sidecar: SidecarFile, threadId: string, entry: Omit<CommentEntry, 'id'>): CommentEntry | null {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread) {
      return null;
    }

    const newEntry: CommentEntry = {
      ...entry,
      id: uuidv4(),
    };
    thread.thread.push(newEntry);
    // Mark thread as draft since it has unpublished changes
    thread.isDraft = true;
    return newEntry;
  }

  /**
   * Delete a thread from the sidecar
   */
  deleteThread(sidecar: SidecarFile, threadId: string): boolean {
    const index = sidecar.comments.findIndex(t => t.id === threadId);
    if (index === -1) {
      return false;
    }
    sidecar.comments.splice(index, 1);
    return true;
  }

  /**
   * Delete a single comment entry from a thread by index.
   * If it was the last comment, removes the entire thread.
   * Returns true if something was deleted.
   */
  deleteComment(sidecar: SidecarFile, threadId: string, commentIndex: number): boolean {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread || commentIndex < 0 || commentIndex >= thread.thread.length) {
      return false;
    }
    thread.thread.splice(commentIndex, 1);
    // If that was the last comment, remove the entire thread
    if (thread.thread.length === 0) {
      this.deleteThread(sidecar, threadId);
    }
    return true;
  }

  /**
   * Delete a single comment entry from a thread by comment ID.
   * If it was the last comment, removes the entire thread.
   * Returns true if something was deleted.
   */
  deleteCommentById(sidecar: SidecarFile, threadId: string, commentId: string): boolean {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread) { return false; }
    const idx = thread.thread.findIndex(c => c.id === commentId);
    if (idx === -1) { return false; }
    return this.deleteComment(sidecar, threadId, idx);
  }

  /**
   * Edit the body of an existing comment entry.
   * Sets the `edited` timestamp. Returns the updated entry or null.
   */
  /**
   * Toggle a thumbs-up reaction on a comment. Returns true if added, false if removed.
   */
  toggleReaction(sidecar: SidecarFile, threadId: string, commentId: string, author: string): boolean {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread) { return false; }
    const comment = thread.thread.find(c => c.id === commentId);
    if (!comment) { return false; }
    if (!comment.reactions) { comment.reactions = []; }
    const idx = comment.reactions.indexOf(author);
    if (idx === -1) {
      comment.reactions.push(author);
      return true;
    } else {
      comment.reactions.splice(idx, 1);
      return false;
    }
  }

  editComment(sidecar: SidecarFile, threadId: string, commentId: string, newBody: string): CommentEntry | null {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread) { return null; }
    const entry = thread.thread.find(c => c.id === commentId);
    if (!entry) { return null; }
    entry.body = newBody;
    entry.edited = new Date().toISOString();
    return entry;
  }

  /**
   * Update thread status
   */
  updateThreadStatus(sidecar: SidecarFile, threadId: string, status: CommentThread['status']): boolean {
    const thread = sidecar.comments.find(t => t.id === threadId);
    if (!thread) {
      return false;
    }
    thread.status = status;
    // Mark thread as draft since it has unpublished changes
    thread.isDraft = true;
    return true;
  }

  /**
   * Get all draft (unpublished) threads
   */
  getDraftThreads(sidecar: SidecarFile): CommentThread[] {
    return sidecar.comments.filter(t => t.isDraft);
  }

  /**
   * Mark all draft threads as published
   */
  markAllPublished(sidecar: SidecarFile): void {
    sidecar.comments.forEach(t => {
      t.isDraft = false;
    });
  }

  /**
   * Validate sidecar file structure
   */
  private validateSidecar(data: unknown): data is SidecarFile {
    if (!data || typeof data !== 'object') {
      return false;
    }
    
    const sidecar = data as Record<string, unknown>;
    
    if (typeof sidecar.doc !== 'string') {
      return false;
    }
    if (sidecar.version !== '1.0') {
      return false;
    }
    if (!Array.isArray(sidecar.comments)) {
      return false;
    }
    
    return true;
  }
}

export const sidecarManager = new SidecarManager();
