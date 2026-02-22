import * as vscode from 'vscode';
import type { MarkdownSection, CommentAnchor, CommentThread } from './models/types';
import { parseMarkdownSections, findSectionBySlug, findSectionByLine, hasContentDrifted } from './utils/markdown';

/**
 * Engine for anchoring comments to markdown sections
 */
export class AnchorEngine {
  private sectionCache: Map<string, MarkdownSection[]> = new Map();

  /**
   * Parse and cache sections for a document
   */
  parseSections(document: vscode.TextDocument): MarkdownSection[] {
    const content = document.getText();
    const sections = parseMarkdownSections(content);
    this.sectionCache.set(document.uri.toString(), sections);
    return sections;
  }

  /**
   * Get cached sections or parse if not cached
   */
  getSections(document: vscode.TextDocument): MarkdownSection[] {
    const cached = this.sectionCache.get(document.uri.toString());
    if (cached) {
      return cached;
    }
    return this.parseSections(document);
  }

  /**
   * Clear cache for a document
   */
  clearCache(documentUri: string): void {
    this.sectionCache.delete(documentUri);
  }

  /**
   * Create an anchor for a section
   */
  createAnchor(section: MarkdownSection): CommentAnchor {
    return {
      sectionSlug: section.slug,
      contentHash: section.contentHash,
      lineHint: section.startLine,
    };
  }

  /**
   * Find the section matching an anchor
   */
  findAnchoredSection(
    sections: MarkdownSection[],
    anchor: CommentAnchor
  ): { section: MarkdownSection; isStale: boolean } | null {
    const section = findSectionBySlug(sections, anchor.sectionSlug);
    
    if (!section) {
      return null;
    }

    const isStale = hasContentDrifted(section, anchor.contentHash);
    return { section, isStale };
  }

  /**
   * Get the VS Code Range for a section heading (single line)
   */
  getSectionRange(document: vscode.TextDocument, section: MarkdownSection): vscode.Range {
    return new vscode.Range(
      new vscode.Position(section.startLine, 0),
      new vscode.Position(section.startLine, document.lineAt(section.startLine).text.length)
    );
  }

  /**
   * Get the VS Code Range covering the full body of a section
   * (from heading through last content line).
   * Used for commenting-range provider so the "+" icon appears on any line.
   */
  getSectionBodyRange(document: vscode.TextDocument, section: MarkdownSection): vscode.Range {
    const lastLine = Math.min(section.endLine - 1, document.lineCount - 1);
    return new vscode.Range(
      new vscode.Position(section.startLine, 0),
      new vscode.Position(lastLine, document.lineAt(lastLine).text.length)
    );
  }

  /**
   * Find the section that contains a given 0-indexed line.
   */
  findSectionByLine(sections: MarkdownSection[], line: number): MarkdownSection | undefined {
    return findSectionByLine(sections, line);
  }

  /**
   * Check if any threads have become stale
   */
  detectStaleThreads(
    sections: MarkdownSection[],
    threads: CommentThread[]
  ): { thread: CommentThread; newStatus: 'stale' | 'open' }[] {
    const updates: { thread: CommentThread; newStatus: 'stale' | 'open' }[] = [];

    for (const thread of threads) {
      if (thread.status === 'resolved') {
        continue; // Don't change resolved threads
      }

      const result = this.findAnchoredSection(sections, thread.anchor);
      
      if (!result) {
        // Section no longer exists - mark as stale
        if (thread.status !== 'stale') {
          updates.push({ thread, newStatus: 'stale' });
        }
      } else if (result.isStale && thread.status !== 'stale') {
        // Content has drifted
        updates.push({ thread, newStatus: 'stale' });
      } else if (!result.isStale && thread.status === 'stale') {
        // Content matches again (maybe user reverted changes)
        updates.push({ thread, newStatus: 'open' });
      }
    }

    return updates;
  }

  /**
   * Find a candidate section to reparent an orphaned thread to.
   * Used when a heading is renamed but the section is still at the same location.
   * 
   * Priority:
   * 1. lineHint matches a section's startLine (heading renamed, same location)
   * 2. contentHash matches (heading renamed, body unchanged)
   * 
   * Returns null if no suitable candidate is found.
   */
  findReparentCandidate(
    sections: MarkdownSection[],
    anchor: CommentAnchor
  ): MarkdownSection | null {
    // Priority 1: lineHint matches a section's startLine
    const byLine = sections.find(s => s.startLine === anchor.lineHint);
    if (byLine) {
      return byLine;
    }

    // Priority 2: contentHash matches (body is same, heading changed)
    const byHash = sections.find(s => s.contentHash === anchor.contentHash);
    if (byHash) {
      return byHash;
    }

    return null;
  }
}

export const anchorEngine = new AnchorEngine();
