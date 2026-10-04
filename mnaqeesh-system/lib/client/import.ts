/**
 * JSON import — the browser-side replacement of the /api/import route.
 *
 * Parses the uploaded archive with the same lib/import.ts the server used
 * (every historical export shape), then upserts the rows through the
 * member's own JWT: RLS `posts_insert_own` pins user_id to the caller,
 * and the 0005 trigger restores soft-deleted posts instead of failing.
 *
 * Ownership note kept from the server version: rows always land on the
 * IMPORTER'S OWN account. Letting one member file content under another
 * member's name would be a quiet way to plant posts in someone else's
 * archive — the manager who needs to import on behalf of a member can
 * use "تبديل الحساب" first.
 */

import { createClient } from '@/lib/supabase/client';
import { normalizeImportRow, parseImportFile } from '@/lib/import';
import type { SavedPostInput } from '@/lib/import-types';
import { logActivity } from '@/lib/client/session';

/** Upload ceiling (soft limit, checked client-side before parsing). */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10000;
const CHUNK = 200;

export type ImportOutcome = {
  total: number;
  added: number;
  updated: number;
  skipped: number;
};

export async function importArchiveFile(
  file: File,
  targetUserId: string
): Promise<ImportOutcome> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`حجم الملف كبير جدًا (الحد ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} ميجابايت).`);
  }

  const text = await file.text();
  const parsed = parseImportFile(text);
  if ('error' in parsed) throw new Error(parsed.error);

  const sourceRows = parsed.rows;
  let skipped = 0;

  const normalized: SavedPostInput[] = [];
  for (const row of sourceRows) {
    const result = normalizeImportRow(row as Record<string, unknown>);
    if (result) normalized.push(result);
    else skipped += 1;
  }

  if (normalized.length === 0) {
    throw new Error('لا يوجد صف صالح في الملف. تأكد أن كل صف يحتوي على id أو postUrl.');
  }
  if (normalized.length > MAX_IMPORT_ROWS) {
    throw new Error(`عدد الصفوف كبير جدًا (الحد ${MAX_IMPORT_ROWS} صفًا في الملف الواحد).`);
  }

  // De-duplicate inside the file itself: the last row wins, as in the extension.
  const byKey = new Map<string, (typeof normalized)[number]>();
  for (const row of normalized) {
    if (byKey.has(row.postKey)) skipped += 1;
    byKey.set(row.postKey, row);
  }
  const unique = [...byKey.values()];

  const supabase = createClient();

  // Which keys already exist for this owner, so "new" vs "updated" is accurate.
  const { data: existing, error: readError } = await supabase
    .from('posts')
    .select('post_key')
    .eq('user_id', targetUserId)
    .in('post_key', unique.map((row) => row.postKey));

  if (readError) throw new Error('تعذر التحقق من المنشورات الموجودة.');

  const existingKeys = new Set(((existing ?? []) as { post_key: string }[]).map((row) => row.post_key));
  const added = unique.filter((row) => !existingKeys.has(row.postKey)).length;
  const updated = unique.length - added;

  const now = new Date().toISOString();
  const payload = unique.map((row) => ({
    user_id: targetUserId,
    post_key: row.postKey,
    author: row.author,
    post_date: row.postDate,
    post_time: row.postTime,
    privacy: row.privacy,
    text: row.text,
    markdown_text: row.markdownText,
    image_urls: row.imageUrls,
    image_direct_urls: row.imageDirectUrls,
    video_url: row.videoUrl,
    video_direct_url: row.videoDirectUrl,
    post_url: row.postUrl,
    saved_at: row.savedAt ?? now,
    deleted_at: null,
    updated_at: now
  }));

  // Insert in chunks so a large archive cannot exceed the request limit.
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('posts')
      .upsert(chunk, { onConflict: 'user_id,post_key' });
    if (error) {
      throw new Error(`تعذر استيراد المنشورات عند الصف ${i + 1}. تحقق من صحة الملف.`);
    }
  }

  await logActivity({
    action: 'posts.import',
    entity: 'posts',
    entityId: targetUserId,
    details: { fileName: file.name, total: sourceRows.length, added, updated, skipped }
  });

  return { total: sourceRows.length, added, updated, skipped };
}
