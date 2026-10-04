/**
 * Input validation and normalisation.
 *
 * Every value that reaches a Supabase query from the browser passes
 * through here, so length limits and enum membership are enforced in
 * exactly one place. (The old server-side route helpers —
 * readPostFilters, page clamps, role coercion — were removed with the
 * API routes when the app became a static export.)
 */

import { POST_STATUSES } from '@/lib/types';

/** Trims, drops control characters, and caps the length. */
export function text(value: unknown, max = 2000): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

/** Long-form text (post bodies, translations). Keeps newlines. */
export function longText(value: unknown, max = 100000): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, max);
}

/** Accepts only http/https URLs, and returns '' otherwise. */
export function safeUrl(value: unknown, max = 4000): string {
  const raw = text(value, max);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

/** A string array of safe URLs. */
export function urlArray(value: unknown, maxItems = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeUrl(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * Normalises a language code: lowercase, letters/digits/dash only,
 * 2–12 characters. This keeps `languages.code` a clean primary key.
 */
export function languageCode(value: unknown): string {
  const raw = text(value, 40).toLowerCase();
  return /^[a-z][a-z0-9-]{1,11}$/.test(raw) ? raw : '';
}

export function postStatus(value: unknown): string | null {
  const raw = text(value, 40);
  return (POST_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

export function uuid(value: unknown): string {
  const raw = text(value, 60);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : '';
}

/**
 * Turns free-text search into a PostgREST `or` filter.
 *
 * PostgREST treats `,` and `)` as syntax, so they are stripped from the
 * user input rather than escaped.
 */
export function buildSearchFilter(query: string): string | null {
  const cleaned = query.replace(/[,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const pattern = `%${cleaned}%`;
  return [`text.ilike.${pattern}`, `markdown_text.ilike.${pattern}`, `author.ilike.${pattern}`, `post_url.ilike.${pattern}`].join(',');
}
