import type MarkdownIt from 'markdown-it';

/**
 * markdown-it plugin that transforms mermaid code blocks into
 * `<pre class="mermaid">` elements for client-side rendering.
 */
export function markdownItMermaid(md: MarkdownIt): void {
  const defaultFence = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const info = token.info.trim().toLowerCase();

    if (info === 'mermaid') {
      // Escape HTML entities in the mermaid content
      const content = md.utils.escapeHtml(token.content);
      return `<pre class="mermaid">${content}</pre>\n`;
    }

    // Fall back to default fence rendering for non-mermaid blocks
    if (defaultFence) {
      return defaultFence(tokens, idx, options, env, self);
    }
    return self.renderToken(tokens, idx, options);
  };
}
