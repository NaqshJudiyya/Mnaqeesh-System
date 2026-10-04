/**
 * JSON import.
 *
 * Accepts every export shape the extension has ever produced, so an
 * existing archive can be loaded straight into مناقيش:
 *
 *   [ ... ]                       a bare array
 *   { rows: [ ... ] }             v2.9+ export
 *   { posts: [ ... ] }
 *   { data: { rows: [ ... ] } }   wrapped variants
 *   { data: { posts: [ ... ] } }
 *
 * Field names are accepted in both the extension's camelCase and the
 * database's snake_case, mirroring the extension's own `normalizeRow`
 * aliases. A UTF-8 BOM is tolerated.
 */

import type { SavedPostInput } from '@/lib/import-types';

/** Field aliases, taken from the extension's `normalizeRow`. */
type RawRow = Record<string, unknown>;

function pick(row: RawRow, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function str(value: unknown, max = 200000): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function url(value: unknown): string {
  const raw = str(value, 4000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function urlArray(value: unknown, maxItems = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(url).filter(Boolean).slice(0, maxItems);
}

/**
 * Extracts the array of rows from any supported root shape.
 * Returns null when the file has no recognisable array.
 */
export function extractRows(parsed: unknown): RawRow[] | null {
  if (Array.isArray(parsed)) return parsed as RawRow[];

  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;

  const candidates: unknown[] = [
    obj.rows,
    obj.posts,
    (obj.data as Record<string, unknown> | undefined)?.rows,
    (obj.data as Record<string, unknown> | undefined)?.posts
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as RawRow[];
  }
  return null;
}

/** Parses the raw text of an uploaded JSON file. */
export function parseImportFile(text: string): { rows: RawRow[] } | { error: string } {
  const cleaned = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return { error: 'الملف فارغ.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    try {
      parsed = JSON.parse(cleaned.replace(/^\s*\uFEFF/, ''));
    } catch {
      return { error: 'الملف ليس JSON صالحًا.' };
    }
  }

  const rows = extractRows(parsed);
  if (!rows) return { error: 'الملف لا يحتوي على مصفوفة rows أو posts صالحة.' };
  if (rows.length === 0) return { error: 'الملف لا يحتوي على أي منشور.' };
  return { rows };
}

/**
 * Builds a stable key for a row.
 *
 * The extension keys its rows by `fb:<id>`, `url:<url>` or `fp:<hash>`.
 * An exported file always carries that as `id`, so we prefer it; when a
 * hand-edited file only has a URL we synthesise `url:<url>` so that
 * re-importing the same file UPDATES the row rather than duplicating it.
 */
export function derivePostKey(row: RawRow): string {
  const explicit = str(pick(row, 'post_key', 'postKey', 'identityKey', 'id'), 500);
  if (explicit) return explicit;

  const postUrl = url(pick(row, 'post_url', 'postUrl'));
  if (postUrl) return `url:${postUrl}`;

  return '';
}

/**
 * Normalises a file row into the shape `public.posts` expects.
 * Returns null when the row cannot be identified at all.
 */
export function normalizeImportRow(row: RawRow): SavedPostInput | null {
  if (!row || typeof row !== 'object') return null;

  const postKey = derivePostKey(row);
  if (!postKey) return null;

  const privacyRaw = str(pick(row, 'privacy'), 20);
  const privacy = ['public', 'friends', 'private', 'unknown'].includes(privacyRaw) ? privacyRaw : 'unknown';

  const savedAtRaw = str(pick(row, 'saved_at', 'savedAt'), 40);
  const savedAt = savedAtRaw && !Number.isNaN(new Date(savedAtRaw).getTime()) ? new Date(savedAtRaw).toISOString() : null;

  return {
    postKey,
    author: str(pick(row, 'author', 'account'), 500) || 'غير معروف',
    postDate: str(pick(row, 'post_date', 'date'), 40),
    postTime: str(pick(row, 'post_time', 'time'), 40),
    privacy,
    text: str(pick(row, 'text'), 200000),
    markdownText: str(pick(row, 'markdown_text', 'markdownText'), 200000),
    imageUrls: urlArray(pick(row, 'image_urls', 'imageUrls', 'images')),
    imageDirectUrls: urlArray(pick(row, 'image_direct_urls', 'imageDirectUrls')),
    videoUrl: url(pick(row, 'video_url', 'videoUrl')),
    videoDirectUrl: url(pick(row, 'video_direct_url', 'videoDirectUrl')),
    postUrl: url(pick(row, 'post_url', 'postUrl')),
    savedAt
  };
}
