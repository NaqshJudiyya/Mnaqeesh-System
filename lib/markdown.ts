/**
 * Markdown → HTML renderer.
 *
 * A faithful port of the extension's own `renderMarkdown` (popup.js), so
 * a post previewed in مناقيش looks identical to the same post in the
 * extension. Deliberately a tiny subset: headings, lists, quotes, rules,
 * bold/italic/code/links/images — matching exactly what the extension's
 * toolbar can produce.
 *
 * SAFETY: the caller's text is HTML-escaped *before* any Markdown
 * substitution, and the only HTML emitted is from this function's own
 * templates. Raw HTML in a post therefore cannot inject markup.
 */

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdownHtml(markdown: string): string {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const inline = (raw: string): string => {
    let x = escapeHtml(raw);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    // The URLs were escaped above, so `&` became `&amp;`; that is still a
    // valid href. Only http(s) is matched, which blocks javascript: URLs.
    x = x.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img alt="$1" src="$2" loading="lazy">');
    x = x.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    x = x.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    x = x.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
    return x;
  };

  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      closeList();
      out.push('<hr>');
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    if (listType) closeList();
    out.push(`<p>${inline(trimmed)}</p>`);
  }

  closeList();
  return out.join('');
}

/** Plain-text view of Markdown, for table cells and previews. */
export function markdownToPlainText(markdown: string): string {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    // Horizontal rules (---, ***, ___) are decoration, not words.
    .replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Word and character counts for the editor footer.
 *
 * Counts the CONTENT, not the Markdown syntax: a heading marker, a bullet,
 * a link target and an image URL are formatting, not words the reader
 * sees. Showing the raw length instead would make a post look longer than
 * it reads, and would count a pasted image URL as prose.
 *
 * Arabic needs no special handling: words are separated by whitespace and
 * punctuation just as in English, so a whitespace split is correct for
 * both. Arabic diacritics are not stripped — they are part of the word.
 */
export function textStats(markdown: string): { words: number; characters: number; charactersNoSpaces: number } {
  const source = String(markdown ?? '');

  const plain = markdownToPlainText(source)
    // Any remaining bare URL would otherwise be counted as one huge "word".
    .replace(/https?:\/\/\S+/g, ' ')
    // Punctuation is not a word boundary in every case, but for counting
    // it is close enough and keeps "كلمة،" from counting as one token.
    .replace(/[.,;:!?،؛؟"'`()\[\]{}<>«»…—–/\\|*_~^]+/g, ' ');

  const words = plain.split(/\s+/).filter((token) => token.length > 0).length;

  return {
    words,
    characters: source.length,
    charactersNoSpaces: source.replace(/\s/g, '').length
  };
}
