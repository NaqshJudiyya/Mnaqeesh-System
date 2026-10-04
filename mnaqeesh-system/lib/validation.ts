/**
 * Input validation and normalisation.
 *
 * Every value that arrives from the browser passes through here before
 * it reaches the database, so length limits and enum membership are
 * enforced in exactly one place.
 */

import { isRole, isStatus, type Role, type Status } from '@/lib/rbac';
import { POST_STATUSES, type PostFilters } from '@/lib/types';

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

export function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
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

export function optionalRole(value: unknown): Role | null {
  return isRole(value) ? value : null;
}

export function optionalStatus(value: unknown): Status | null {
  return isStatus(value) ? value : null;
}

export function postStatus(value: unknown): string | null {
  const raw = text(value, 40);
  return (POST_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

export function uuid(value: unknown): string {
  const raw = text(value, 60);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : '';
}

/** Clamps a page number into a sane range. */
export function pageNumber(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 100000);
}

/** Clamps a page size (25–200). */
export function pageSize(value: unknown, fallback = 50): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

/**
 * Accepts only a strict ISO calendar date or date-time.
 *
 * The saved_at filters go straight into `.gte()`/`.lte()`, and Postgres
 * rejects anything else with 22007, which would surface as a 500 instead
 * of a friendly empty result.
 */
export function isoDate(value: unknown): string {
  const raw = text(value, 30);
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(raw)) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : raw;
}

/**
 * Reads the dashboard's post filters out of a URLSearchParams or a plain
 * object, applying the same limits either way.
 */
export function readPostFilters(source: URLSearchParams | Record<string, unknown>): PostFilters {
  const get = (key: string): unknown => {
    if (source instanceof URLSearchParams) return source.get(key);
    return source[key];
  };

  const sort = get('sort') === 'oldest' ? 'oldest' : 'newest';
  const privacy = text(get('privacy'), 20);
  const status = postStatus(get('status')) ?? '';

  return {
    q: text(get('q'), 200),
    owner: uuid(get('owner')),
    privacy: ['public', 'friends', 'private', 'unknown'].includes(privacy) ? privacy : '',
    status,
    language: languageCode(get('language')),
    postKey: text(get('post'), 500),
    from: isoDate(get('from')),
    to: isoDate(get('to')),
    page: pageNumber(get('page')),
    pageSize: pageSize(get('pageSize')),
    sort
  };
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
