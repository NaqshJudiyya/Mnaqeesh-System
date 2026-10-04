import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logActivity, requireUser } from '@/lib/session';
import { isUsableAccount } from '@/lib/rbac';
import { normalizeImportRow, parseImportFile } from '@/lib/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Upload ceiling. A JSON archive of a few thousand posts is well under this. */
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 10000;

/**
 * Imports a JSON archive produced by the extension.
 *
 * Why this exists: the extension could import JSON, but the server could
 * not — so the only way to load an existing archive into مناقيش was to
 * re-sync it from a browser that already had it.
 *
 * Behaviour, matching the extension's own importer:
 *   - accepts every historical root shape (array / rows / posts / data.*)
 *   - rows already present are UPDATED, not duplicated
 *   - unusable rows are skipped and counted
 *
 * The owner of the imported rows is the importer by default, because in
 * the common case a member is uploading their own old archive.
 */
export async function POST(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!isUsableAccount(session.profile)) {
    return NextResponse.json({ error: 'حسابك غير مفعّل.' }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'تعذر قراءة الملف المرفوع.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'لم يتم إرفاق أي ملف.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `حجم الملف كبير جدًا (الحد ${Math.round(MAX_BYTES / 1024 / 1024)} ميجابايت).` },
      { status: 413 }
    );
  }

  // Imports always land on the importer's own account.
  //
  // Letting one member file an import under another member's name would be
  // a quiet way to plant content in someone else's archive. The manager
  // who needs to import on behalf of a member can use "switch account"
  // first, which is explicit and auditable.
  const targetUserId = session.userId;

  const text = await file.text();
  const parsed = parseImportFile(text);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const sourceRows = parsed.rows;
  const skippedByShape: number[] = [];

  // Normalise, dropping rows we cannot identify.
  const normalized = [];
  for (const row of sourceRows) {
    const result = normalizeImportRow(row as Record<string, unknown>);
    if (result) normalized.push(result);
    else skippedByShape.push(1);
  }

  if (normalized.length === 0) {
    return NextResponse.json(
      { error: 'لا يوجد صف صالح في الملف. تأكد أن كل صف يحتوي على id أو postUrl.' },
      { status: 400 }
    );
  }

  if (normalized.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `عدد الصفوف كبير جدًا (الحد ${MAX_ROWS} صفًا في الملف الواحد).` },
      { status: 413 }
    );
  }

  // De-duplicate inside the file itself: the last row wins, as in the extension.
  const byKey = new Map<string, (typeof normalized)[number]>();
  let duplicateInFile = 0;
  for (const row of normalized) {
    if (byKey.has(row.postKey)) duplicateInFile += 1;
    byKey.set(row.postKey, row);
  }
  const unique = [...byKey.values()];

  const service = createServiceClient();

  // Find which keys already exist for this owner, so "new" vs "updated" is accurate.
  const { data: existing, error: readError } = await service
    .from('posts')
    .select('post_key')
    .eq('user_id', targetUserId)
    .in('post_key', unique.map((row) => row.postKey));

  if (readError) {
    console.error('[import] existence check failed:', readError.message);
    return NextResponse.json({ error: 'تعذر التحقق من المنشورات الموجودة.' }, { status: 500 });
  }

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
  const CHUNK = 200;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await service
      .from('posts')
      .upsert(chunk, { onConflict: 'user_id,post_key' });

    if (error) {
      console.error('[import] upsert failed:', error.message);
      return NextResponse.json(
        {
          error: `تعذر استيراد المنشورات عند الصف ${i + 1}. تحقق من صحة الملف.`,
          importedBeforeFailure: i
        },
        { status: 500 }
      );
    }
  }

  const skipped = skippedByShape.length + duplicateInFile;

  await logActivity({
    actorId: session.userId,
    actorEmail: session.email,
    action: 'posts.import',
    entity: 'posts',
    entityId: targetUserId,
    details: {
      fileName: file.name,
      total: sourceRows.length,
      added,
      updated,
      skipped,
      ownerIsSelf: targetUserId === session.userId
    }
  });

  return NextResponse.json({
    ok: true,
    total: sourceRows.length,
    added,
    updated,
    skipped
  });
}
