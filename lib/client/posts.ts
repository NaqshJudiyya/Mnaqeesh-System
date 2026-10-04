/**
 * Posts data access — the static-hosting replacement of lib/data.ts.
 *
 * Every query runs through the browser client with the signed-in
 * member's own JWT, so RLS (posts_select_scope / posts_update_scope /
 * posts_insert_own) does the authorisation that route handlers and the
 * service client used to do:
 *
 *   collector  -> only their own rows (read AND write)
 *   editor     -> every row
 *   translator -> every row, but no writes (no policy branch)
 *   admin      -> every row
 *
 * Member identities (owner / translator names) are loaded only for the
 * manager, mirroring the old `canSeeMembers` rule — editors and
 * translators must never be able to enumerate other members.
 */

import { createClient } from '@/lib/supabase/client';
import { canSeeAllPosts, canSeeMembers, type Profile } from '@/lib/rbac';
import {
  type LanguageRow,
  type PostFilters,
  type PostRow,
  type PostsPage,
  type TranslationRow
} from '@/lib/types';
import { buildSearchFilter } from '@/lib/validation';
import { logActivity } from '@/lib/client/session';

export const POST_COLUMNS =
  'id,user_id,post_key,author,post_date,post_time,privacy,text,markdown_text,image_urls,' +
  'image_direct_urls,video_url,video_direct_url,post_url,saved_at,status,editor_note,' +
  'edited_markdown,edited_text,edited_at,edited_by,deleted_at,created_at,updated_at';

/**
 * Export ceiling. The static app builds files in the browser, so the cap
 * is lower than the old server default by default and can be raised per
 * deployment through NEXT_PUBLIC_EXPORT_ROW_LIMIT.
 */
export const EXPORT_ROW_LIMIT = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_EXPORT_ROW_LIMIT);
  if (Number.isFinite(raw) && raw >= 1000) return Math.min(Math.floor(raw), 50000);
  return 10000;
})();

/**
 * A PostgREST `or` expression that matches every row (an empty `or=()`
 * would be invalid PostgREST).
 */
const SEARCH_ALL = 'post_key.neq.__mnaqeesh_no_such_key__';

type OwnerInfo = { email: string; full_name: string; avatar_url: string };

/** Display names for a set of user ids — admin only (RLS-enforced). */
async function loadOwners(userIds: string[]): Promise<Map<string, OwnerInfo>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const supabase = createClient();
  const { data } = await supabase
    .from('profiles')
    .select('id,email,full_name,avatar_url')
    .in('id', unique);
  if (!data) return new Map();
  return new Map(
    (data as (OwnerInfo & { id: string })[]).map((row) => [
      row.id,
      { email: row.email, full_name: row.full_name, avatar_url: row.avatar_url }
    ])
  );
}

/** Attaches translation rows (names only for the manager) to posts. */
async function attachTranslations(
  posts: PostRow[],
  revealTranslators: boolean
): Promise<PostRow[]> {
  if (posts.length === 0) return posts;

  const supabase = createClient();
  const { data, error } = await supabase
    .from('translations')
    .select(
      'id,post_id,language_code,title,translated_text,body_markdown,translator_id,is_complete,created_at,updated_at'
    )
    .in('post_id', posts.map((p) => p.id))
    .order('created_at', { ascending: true });

  if (error || !data) return posts.map((post) => ({ ...post, translations: [] }));

  const translations = data as TranslationRow[];
  const owners = revealTranslators
    ? await loadOwners(translations.map((t) => t.translator_id).filter((v): v is string => Boolean(v)))
    : new Map<string, OwnerInfo>();

  const grouped = new Map<string, TranslationRow[]>();
  for (const translation of translations) {
    const info = translation.translator_id ? owners.get(translation.translator_id) : undefined;
    const enriched: TranslationRow = {
      ...translation,
      translator: info ? { full_name: info.full_name, email: info.email } : null
    };
    const list = grouped.get(translation.post_id);
    if (list) list.push(enriched);
    else grouped.set(translation.post_id, [enriched]);
  }

  return posts.map((post) => ({ ...post, translations: grouped.get(post.id) ?? [] }));
}

/**
 * Post ids that have a translation in the requested language. Empty
 * array genuinely means "no matches" — the caller returns early then.
 */
export async function postIdsTranslatedInto(language: string | undefined): Promise<string[] | null> {
  if (!language) return null;
  const supabase = createClient();
  const { data } = await supabase.from('translations').select('post_id').eq('language_code', language);
  if (!data) return [];
  return [...new Set((data as { post_id: string }[]).map((row) => row.post_id))];
}

/**
 * Paged, filtered list of posts (live rows, or trash when filters.trash).
 * The collector's "only my own posts" rule comes from RLS.
 */
export async function listPosts(profile: Profile, filters: PostFilters): Promise<PostsPage> {
  const supabase = createClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const search = (filters.q ? buildSearchFilter(filters.q) : null) ?? SEARCH_ALL;

  const languageIds = await postIdsTranslatedInto(filters.language);
  if (languageIds && languageIds.length === 0) {
    return { rows: [], total: 0, page, pageSize };
  }

  let query = supabase
    .from('posts')
    .select(POST_COLUMNS, { count: 'exact' })
    .or(search);

  query = filters.trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null);

  const ownerId = filters.owner && filters.owner.length > 0 ? filters.owner : null;
  if (ownerId && canSeeAllPosts(profile)) query = query.eq('user_id', ownerId);
  if (filters.privacy) query = query.eq('privacy', filters.privacy);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.postKey) query = query.eq('post_key', filters.postKey);
  if (filters.from) query = query.gte('saved_at', filters.from);
  if (filters.to) query = query.lte('saved_at', filters.to);
  if (languageIds) query = query.in('id', languageIds);
  query = query.order('saved_at', { ascending: filters.sort === 'oldest' });

  const { data, error, count } = await query.range(from, to);
  if (error) throw new Error('تعذر تحميل المنشورات: ' + error.message);

  let rows = (data ?? []) as unknown as PostRow[];

  // Only the manager may see who saved what (see lib/rbac.canSeeMembers).
  if (canSeeMembers(profile) && rows.length > 0) {
    const owners = await loadOwners(rows.map((row) => row.user_id));
    rows = rows.map((row) => ({ ...row, owner: owners.get(row.user_id) ?? null }));
  }

  rows = await attachTranslations(rows, canSeeMembers(profile));

  return { rows, total: count ?? rows.length, page, pageSize };
}

/** A single post with its translations. `includeDeleted` for the trash. */
export async function getPost(
  profile: Profile,
  postId: string,
  options?: { includeDeleted?: boolean }
): Promise<PostRow | null> {
  const supabase = createClient();
  let query = supabase.from('posts').select(POST_COLUMNS).eq('id', postId);
  query = options?.includeDeleted ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const post = data as unknown as PostRow;
  if (canSeeMembers(profile)) {
    const owners = await loadOwners([post.user_id]);
    post.owner = owners.get(post.user_id) ?? null;
  }
  const [withTranslations] = await attachTranslations([post], canSeeMembers(profile));
  return withTranslations ?? post;
}

/**
 * Fetches posts for export — same shape as the old server helper, capped
 * so the browser never builds an unbounded file in memory.
 */
export async function listPostsForExport(
  profile: Profile,
  filters: Omit<PostFilters, 'page' | 'pageSize'>
): Promise<PostRow[]> {
  const supabase = createClient();
  const search = (filters.q ? buildSearchFilter(filters.q) : null) ?? SEARCH_ALL;

  const languageIds = await postIdsTranslatedInto(filters.language);
  if (languageIds && languageIds.length === 0) return [];

  let query = supabase.from('posts').select(POST_COLUMNS).or(search);
  query = query.is('deleted_at', null); // the trash is never exportable

  const ownerId = filters.owner && filters.owner.length > 0 ? filters.owner : null;
  if (ownerId && canSeeAllPosts(profile)) query = query.eq('user_id', ownerId);
  if (filters.privacy) query = query.eq('privacy', filters.privacy);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.postKey) query = query.eq('post_key', filters.postKey);
  if (filters.from) query = query.gte('saved_at', filters.from);
  if (filters.to) query = query.lte('saved_at', filters.to);
  if (languageIds) query = query.in('id', languageIds);
  query = query.order('saved_at', { ascending: filters.sort === 'oldest' });

  const { data, error } = await query.limit(EXPORT_ROW_LIMIT);
  if (error) throw new Error('تعذر تحضير البيانات للتصدير: ' + error.message);

  let rows = (data ?? []) as unknown as PostRow[];
  if (canSeeMembers(profile) && rows.length > 0) {
    const owners = await loadOwners(rows.map((row) => row.user_id));
    rows = rows.map((row) => ({ ...row, owner: owners.get(row.user_id) ?? null }));
  }
  return attachTranslations(rows, canSeeMembers(profile));
}

// ---------------------------------------------------------------------
// Mutations. RLS (posts_update_scope) decides which rows actually move;
// every function returns the number of rows that really changed, so a
// permission mismatch is visible instead of a silent no-op.
// ---------------------------------------------------------------------

function mutationError(operation: string, message: string): Error {
  const normalized = /row-level security|permission denied/i.test(message)
    ? 'لا تملك صلاحية تنفيذ هذا الإجراء على هذه المنشورات.'
    : message;
  return new Error(`${operation}: ${normalized}`);
}

/** Applies one patch to many posts; returns how many rows changed. */
async function patchPosts(
  postIds: string[],
  patch: Record<string, unknown>,
  operation: string
): Promise<number> {
  const supabase = createClient();
  const { data, error } = await supabase.from('posts').update(patch).in('id', postIds).select('id');
  if (error) throw mutationError(operation, error.message);
  return (data ?? []).length;
}

/** Dashboard edit (status / editor_note / author). Author is admin-only. */
export async function updatePost(
  postId: string,
  patch: { status?: string; editor_note?: string; author?: string }
): Promise<number> {
  return patchPosts([postId], patch, 'تعذر تحديث المنشور');
}

/**
 * Saves an in-app Markdown edit. Passing empty strings clears the
 * override so the post falls back to what the extension saved — exactly
 * the old server behaviour. `edited_by` comes from the session itself.
 */
export async function updatePostContent(
  postId: string,
  input: { markdown: string; text: string; status?: string }
): Promise<void> {
  const markdown = input.markdown.trim();
  const text = input.text.trim();
  const isClearing = markdown.length === 0 && text.length === 0;

  let editorId: string | null = null;
  if (!isClearing) {
    const { data } = await createClient().auth.getSession();
    editorId = data.session?.user.id ?? null;
  }

  const patch: Record<string, unknown> = isClearing
    ? { edited_markdown: null, edited_text: null, edited_at: null, edited_by: null }
    : {
        edited_markdown: markdown,
        edited_text: text,
        edited_at: new Date().toISOString(),
        edited_by: editorId
      };
  if (input.status) patch.status = input.status;

  const { data, error } = await createClient()
    .from('posts')
    .update(patch)
    .eq('id', postId)
    .select('id');
  if (error) throw mutationError('تعذر حفظ التعديل', error.message);
  if ((data ?? []).length === 0) {
    throw new Error('لا تملك صلاحية تعديل هذا المنشور.');
  }
}

/** Soft-delete — moves posts to the trash. Returns how many moved. */
export async function softDeletePosts(postIds: string[]): Promise<number> {
  return patchPosts(postIds, { deleted_at: new Date().toISOString() }, 'تعذر حذف المنشورات');
}

/** Brings soft-deleted posts back. Returns how many were restored. */
export async function restorePosts(postIds: string[]): Promise<number> {
  return patchPosts(postIds, { deleted_at: null }, 'تعذر استعادة المنشورات');
}

/**
 * The ids in `requested` the viewer can see (and therefore act on).
 * Reads through the viewer's own client, so RLS hides rows a collector
 * does not own; the caller still runs its per-row rbac check.
 */
export async function getPostsByIds(
  profile: Profile,
  ids: string[],
  options?: { trash?: boolean }
): Promise<Pick<PostRow, 'id' | 'user_id'>[]> {
  if (ids.length === 0) return [];
  const supabase = createClient();
  let query = supabase.from('posts').select('id,user_id').in('id', ids);
  query = options?.trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null);
  const { data, error } = await query;
  if (error) throw new Error('تعذر التحقق من المنشورات: ' + error.message);
  return ((data ?? []) as unknown as Pick<PostRow, 'id' | 'user_id'>[]).filter(
    (row) => canSeeAllPosts(profile) || row.user_id === profile.id
  );
}

/** One request may act on at most this many posts. */
export const MAX_BULK_IDS = 200;

/** Shared bulk implementation for the posts table's bulk bar. */
export async function runBulkAction(
  profile: Profile,
  input: {
    action: 'status' | 'delete' | 'restore' | 'author';
    ids: string[];
    status?: string;
    author?: string;
    canEditRow: (row: { user_id: string }) => boolean;
    canDeleteRow: (row: { user_id: string }) => boolean;
  }
): Promise<{ updated: number; skipped: number }> {
  const isTrashAction = input.action === 'restore';
  const rows = await getPostsByIds(profile, input.ids, { trash: isTrashAction });

  const allowedIds = rows
    .filter((row) =>
      input.action === 'status'
        ? input.canEditRow(row)
        : input.action === 'author'
          ? true // author is admin-only; the caller gates the whole action
          : input.canDeleteRow(row)
    )
    .map((row) => row.id);

  let updated = 0;
  if (allowedIds.length > 0) {
    if (input.action === 'delete') updated = await softDeletePosts(allowedIds);
    else if (input.action === 'restore') updated = await restorePosts(allowedIds);
    else if (input.action === 'status') updated = await patchPosts(allowedIds, { status: input.status }, 'تعذر تغيير الحالة');
    else if (input.action === 'author') updated = await patchPosts(allowedIds, { author: input.author ?? '' }, 'تعذر تغيير صاحب البوست');
  }

  await logActivity({
    action: `posts.bulk_${input.action}`,
    entity: 'posts',
    entityId: allowedIds[0] ?? '',
    details: { requested: input.ids.length, updated, ...(input.status ? { status: input.status } : {}), ...(input.author !== undefined ? { author: input.author } : {}) }
  });

  return { updated, skipped: input.ids.length - allowedIds.length };
}

// ---------------------------------------------------------------------
// Languages + translations (browser-side)
// ---------------------------------------------------------------------

export async function listLanguages(): Promise<LanguageRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('languages')
    .select('code,name_ar,name_en,is_default,created_at')
    .order('name_ar', { ascending: true });
  if (error) return [];
  return (data ?? []) as LanguageRow[];
}

export async function countTranslationsForLanguage(code: string): Promise<number> {
  const supabase = createClient();
  const { count } = await supabase
    .from('translations')
    .select('id', { count: 'exact', head: true })
    .eq('language_code', code);
  return count ?? 0;
}

/** Which languages already have a translation (collector: own posts only). */
export async function translationCountsByLanguage(): Promise<Record<string, number>> {
  const supabase = createClient();
  const { data } = await supabase.from('translations').select('language_code');
  if (!data) return {};
  const counts: Record<string, number> = {};
  for (const row of data as { language_code: string }[]) {
    counts[row.language_code] = (counts[row.language_code] ?? 0) + 1;
  }
  return counts;
}

/** Creates or replaces one post's translation in one language. */
export async function upsertTranslation(input: {
  postId: string;
  languageCode: string;
  languageNameAr?: string;
  languageNameEn?: string;
  title: string;
  translatedText: string;
  bodyMarkdown: string;
  translatorId: string;
  isComplete: boolean;
}): Promise<TranslationRow> {
  const supabase = createClient();

  // Register a brand-new language on the fly (languages_insert policy).
  const { data: existingLanguage } = await supabase
    .from('languages')
    .select('code')
    .eq('code', input.languageCode)
    .maybeSingle();
  if (!existingLanguage) {
    const { error: languageError } = await supabase.from('languages').insert({
      code: input.languageCode,
      name_ar: input.languageNameAr || input.languageCode,
      name_en: input.languageNameEn || input.languageCode,
      is_default: false,
      created_by: input.translatorId
    });
    if (languageError) throw new Error('تعذر إضافة اللغة: ' + languageError.message);
  }

  const { data, error } = await supabase
    .from('translations')
    .upsert(
      {
        post_id: input.postId,
        language_code: input.languageCode,
        title: input.title,
        translated_text: input.translatedText,
        body_markdown: input.bodyMarkdown,
        translator_id: input.translatorId,
        is_complete: input.isComplete,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'post_id,language_code' }
    )
    .select(
      'id,post_id,language_code,title,translated_text,body_markdown,translator_id,is_complete,created_at,updated_at'
    )
    .single();

  if (error) throw new Error('تعذر حفظ الترجمة: ' + error.message);
  return data as TranslationRow;
}

export async function deleteTranslation(translationId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('translations').delete().eq('id', translationId);
  if (error) {
    throw new Error(
      /row-level security|permission denied/i.test(error.message)
        ? 'لا يمكن حذف ترجمة كتبها مترجم آخر أو ترجمة مكتملة.'
        : 'تعذر حذف الترجمة: ' + error.message
    );
  }
}

export async function addLanguage(input: {
  code: string;
  nameAr: string;
  nameEn: string;
  createdBy: string;
}): Promise<LanguageRow> {
  const supabase = createClient();
  const { data: existing } = await supabase
    .from('languages')
    .select('code,name_ar,name_en,is_default,created_at')
    .eq('code', input.code)
    .maybeSingle();
  if (existing) return existing as LanguageRow;

  const { data, error } = await supabase
    .from('languages')
    .insert({
      code: input.code,
      name_ar: input.nameAr || input.nameEn || input.code,
      name_en: input.nameEn || input.nameAr || input.code,
      is_default: false,
      created_by: input.createdBy
    })
    .select('code,name_ar,name_en,is_default,created_at')
    .single();
  if (error) throw new Error('تعذر إضافة اللغة: ' + error.message);
  return data as LanguageRow;
}

export async function deleteLanguage(code: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('languages').delete().eq('code', code);
  if (error) {
    throw new Error(
      /foreign key|still referenced/i.test(error.message)
        ? 'لا يمكن حذف اللغة: توجد ترجمات تستخدمها. احذف الترجمات أولًا.'
        : 'تعذر حذف اللغة: ' + error.message
    );
  }
}

// ---------------------------------------------------------------------
// Dashboard summary numbers
// ---------------------------------------------------------------------

export type DashboardStats = {
  totalPosts: number;
  totalMembers: number;
  activeMembers: number;
  pendingMembers: number;
  translatedPosts: number;
  languageCount: number;
};

export async function getDashboardStats(profile: Profile): Promise<DashboardStats> {
  const supabase = createClient();
  const seesAll = canSeeAllPosts(profile);

  let postsQuery = supabase.from('posts').select('id', { count: 'exact' }).is('deleted_at', null);
  if (!seesAll) postsQuery = postsQuery.eq('user_id', profile.id);

  const [postsResult, languagesResult, membersResult] = await Promise.all([
    postsQuery,
    supabase.from('languages').select('code', { count: 'exact', head: true }),
    // Member figures are manager-only; RLS hides the rows from everyone else.
    seesAll ? supabase.from('profiles').select('status') : Promise.resolve({ data: [] as { status: string }[] })
  ]);

  const visibleIds = ((postsResult.data ?? []) as { id: string }[]).map((row) => row.id);

  let translatedPosts = 0;
  if (visibleIds.length > 0) {
    const { data: translationRows } = await supabase
      .from('translations')
      .select('post_id')
      .in('post_id', visibleIds);
    translatedPosts = new Set(
      ((translationRows ?? []) as { post_id: string }[]).map((row) => row.post_id)
    ).size;
  }

  const members = (membersResult.data ?? []) as { status: string }[];

  return {
    totalPosts: postsResult.count ?? visibleIds.length,
    totalMembers: members.length,
    activeMembers: members.filter((m) => m.status === 'active').length,
    pendingMembers: members.filter((m) => m.status === 'pending').length,
    translatedPosts,
    languageCount: languagesResult.count ?? 0
  };
}
