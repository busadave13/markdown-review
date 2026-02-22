import type { MarkdownSection } from '../models/types';
import { computeContentHash, slugify } from './hash';

/**
 * Parse a markdown document and extract sections by heading
 */
export function parseMarkdownSections(content: string): MarkdownSection[] {
  // Normalize line endings (Windows \r\n → \n)
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedContent.split('\n');
  const sections: MarkdownSection[] = [];
  
  let currentSection: Partial<MarkdownSection> | null = null;
  let contentLines: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      if (currentSection) {
        contentLines.push(line);
      }
      continue;
    }

    // Skip heading detection inside code blocks
    const headingMatch = !inCodeBlock ? line.match(/^(#{1,6})\s+(.+)$/) : null;

    if (headingMatch) {
      // Save previous section if exists
      if (currentSection && currentSection.heading) {
        const sectionContent = contentLines.join('\n').trim();
        sections.push({
          heading: currentSection.heading,
          slug: currentSection.slug!,
          level: currentSection.level!,
          startLine: currentSection.startLine!,
          endLine: i,
          content: sectionContent,
          contentHash: computeContentHash(sectionContent),
        });
      }

      // Start new section
      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();
      currentSection = {
        heading,
        slug: slugify(heading),
        level,
        startLine: i,
      };
      contentLines = [];
    } else if (currentSection) {
      contentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection && currentSection.heading) {
    const sectionContent = contentLines.join('\n').trim();
    sections.push({
      heading: currentSection.heading,
      slug: currentSection.slug!,
      level: currentSection.level!,
      startLine: currentSection.startLine!,
      endLine: lines.length,
      content: sectionContent,
      contentHash: computeContentHash(sectionContent),
    });
  }

  return sections;
}

/**
 * Find a section by slug
 */
export function findSectionBySlug(sections: MarkdownSection[], slug: string): MarkdownSection | undefined {
  return sections.find(s => s.slug === slug);
}

/**
 * Find the section that contains a given 0-indexed line number.
 * A section spans from its startLine (inclusive) to its endLine (exclusive).
 */
export function findSectionByLine(sections: MarkdownSection[], line: number): MarkdownSection | undefined {
  return sections.find(s => line >= s.startLine && line < s.endLine);
}

/**
 * Check if a section's content hash has drifted from the stored hash
 */
export function hasContentDrifted(section: MarkdownSection, storedHash: string): boolean {
  return section.contentHash !== storedHash;
}
