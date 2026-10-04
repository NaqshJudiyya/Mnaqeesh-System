/**
 * Data access for posts, translations, languages, and the audit log.
 *
 * READ paths use the signed-in user's own client, so the RLS policies
 * from the migration decide what is visible:
 *
 *   collector  -> only rows where user_id = auth.uid()
 *   editor     -> every row
 *   translator -> every row
 *   admin      -> every row
 *
 * WRITE paths use the service client and are guarded by lib/rbac.ts,
 * because the dashboard has to touch rows the caller does not own
 * (an editor editing someone else's post, an admin deleting any post).
 */

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canEditPost, canSeeAllPosts, canSeeMembers, type Profile } from '@/lib/rbac';
import {
  PRIVACY_LABELS,
  type LanguageRow,
  type PostFilters,
  type PostRow,
  type PostsPage,
  type TranslationRow
} from '@/lib/types';
import { buildSearchFilter } from '@/lib/validation';

export const POST_COLUMNS = [
  'id',
  'user_id',
  'post_key',
  'author',
  'post_date',
  'post_time',
  'privacy',
  'text',
  'markdown_text',
  'image_urls',
  'image_direct_urls',
  'video_url',
  'video_direct_url',
  'post_url',
  'saved_at',
  'status',
  'editor_note',
  'edited_markdown',
  'edited_text',
  'edited_at',
  'edited_by',
  'deleted_at',
  'created_at',
  'updated_at'
].join(',');

type OwnerInfo = { email: string; full_name: string; avatar_url: string };

/**
 * Loads display names for a set of user ids in one query, using the
 * service client because a collector's RLS would hide other profiles.
 * Only the caller's own row is ever attached for a collector.
 */
async function loadOwners(userIds: string[]): Promise<Map<string, OwnerInfo>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const service = createServiceClient();
  const { data, error } = await service
    .from('profiles')
    .select('id,email,full_name,avatar_url')
    .in('id', unique);

  if (error || !data) return new Map();
  return new Map(
    (data as (OwnerInfo & { id: string })[]).map((row) => [
      row.id,
      { email: row.email, full_name: row.full_name, avatar_url: row.avatar_url }
    ])
  );
}

/** Attaches translation rows (and translator names) to a page of posts. */
/**
 * Attaches translation rows to a page of posts.
 *
 * `revealTranslators` must only be true for the manager. Translators and
 * editors are not allowed to see the other members of the system, and a
 * translator's name and email is exactly that.
 */
async function attachTranslations(posts: PostRow[], revealTranslators: boolean): Promise<PostRow[]> {
  if (posts.length === 0) return posts;

  const service = createServiceClient();
  const { data, error } = await service
    .from('translations')
    .select('id,post_id,language_code,title,translated_text,body_markdown,translator_id,is_complete,created_at,updated_at')
    .in('post_id', posts.map((p) => p.id))
    .order('created_at', { ascending: true });

  if (error || !data) return posts.map((post) => ({ ...post, translations: [] }));

  const translations = data as TranslationRow[];
  const translatorIds = translations.map((t) => t.translator_id).filter((v): v is string => Boolean(v));
  const owners = revealTranslators ? await loadOwners(translatorIds) : new Map<string, OwnerInfo>();

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
 * Whose posts may this viewer list?
 *
 *   collector -> only their own id (never null, never another member)
 *   manager   -> an explicit member filter, or null for everyone
 *   others    -> null, meaning the whole pool
 *
 * A null result means "no owner filter at all", so the caller must NOT
 * chain `.eq('user_id', null)`: `eq()` always appends its value, which
 * would send the literal `user_id=eq.null` to a `uuid` column and make
 * Postgres fail with 22P02. Filters are therefore applied conditionally.
 */
function scopeToUserId(profile: Profile, owner?: string): string | null {
  if (!canSeeAllPosts(profile)) return profile.id;
  return owner && owner.length > 0 ? owner : null;
}

/** Returns the value only when it is a real filter, otherwise null. */
function filterValue(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * A PostgREST `or` expression that matches every row.
 *
 * Used when no search term is present so the query chain can stay a
 * single expression (an empty `or=()` would be invalid PostgREST).
 */
const SEARCH_ALL = 'post_key.neq.__mnaqeesh_no_such_key__';

/**
 * Applies the optional post filters to a PostgREST query.
 *
 * Typed structurally rather than with the library's generic builder so
 * the narrowed type returned by each call stays assignable.
 */
type Queryish = {
  eq(column: string, value: unknown): Queryish;
  in(column: string, values: readonly unknown[]): Queryish;
  gte(column: string, value: unknown): Queryish;
  lte(column: string, value: unknown): Queryish;
  order(column: string, options: { ascending: boolean }): Queryish;
};

function applyPostFilters<T extends Queryish>(
  query: T,
  filters: Omit<PostFilters, 'page' | 'pageSize'>,
  matchingPostIds?: string[]
): T {
  let q: Queryish = query;

  if (matchingPostIds) q = q.in('id', matchingPostIds);

  const ownerId = filters.owner && filters.owner.length > 0 ? filters.owner : null;
  if (ownerId) q = q.eq('user_id', ownerId);

  const privacy = filterValue(filters.privacy);
  if (privacy) q = q.eq('privacy', privacy);

  const status = filterValue(filters.status);
  if (status) q = q.eq('status', status);

  const postKey = filterValue(filters.postKey);
  if (postKey) q = q.eq('post_key', postKey);

  const from = filterValue(filters.from);
  if (from) q = q.gte('saved_at', from);

  const to = filterValue(filters.to);
  if (to) q = q.lte('saved_at', to);

  return q.order('saved_at', { ascending: filters.sort === 'oldest' }) as T;
}

/**
 * Post ids that have a translation in the requested language.
 *
 * Returns null when no language filter applies, and an EMPTY array when
 * the filter is set but nothing matches — the caller must treat those two
 * cases differently (no filter vs. no results).
 */
async function postIdsTranslatedInto(language: string | undefined): Promise<string[] | null> {
  if (!language) return null;

  const service = createServiceClient();
  const { data, error } = await service
    .from('translations')
    .select('post_id')
    .eq('language_code', language);

  if (error || !data) return [];
  return [...new Set((data as { post_id: string }[]).map((row) => row.post_id))];
}

/**
 * Paged, filtered list of posts.
 *
 * The collector's "only my own posts" rule is applied by RLS, and is also
 * pinned explicitly here so the intent stays visible and the query keeps
 * working if a policy is later relaxed.
 */
export async function listPosts(
  profile: Profile,
  filters: PostFilters
): Promise<PostsPage> {
  const supabase = await createClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const search = (filters.q ? buildSearchFilter(filters.q) : null) ?? SEARCH_ALL;

  // A collector is pinned to their own id; others get the optional filter.
  const scoped = { ...filters, owner: scopeToUserId(profile, filters.owner) ?? undefined };

  // "Has a translation in language X" is a separate table, so resolve it
  // to a set of post ids first. An empty array here genuinely means
  // "no post has that language", so we can return early.
  const languageIds = await postIdsTranslatedInto(filters.language);
  if (languageIds && languageIds.length === 0) {
    return { rows: [], total: 0, page, pageSize };
  }

  const base = supabase
    .from('posts')
    .select(POST_COLUMNS, { count: 'exact' })
    .is('deleted_at', null)
    .or(search);

  const { data, error, count } = await applyPostFilters(base, scoped, languageIds ?? undefined).range(from, to);

  if (error) throw new Error('تعذر تحميل المنشورات: ' + error.message);

  let rows = (data ?? []) as unknown as PostRow[];

  // Only the manager may see who saved what: for an editor or translator
  // these labels would amount to the member list they are not allowed to
  // see. See lib/rbac.ts `canSeeMembers`.
  if (canSeeMembers(profile) && rows.length > 0) {
    const owners = await loadOwners(rows.map((row) => row.user_id));
    rows = rows.map((row) => ({ ...row, owner: owners.get(row.user_id) ?? null }));
  }

  rows = await attachTranslations(rows, canSeeMembers(profile));

  return { rows, total: count ?? rows.length, page, pageSize };
}

/** A single post with its translations. Returns null when not visible. */
export async function getPost(profile: Profile, postId: string): Promise<PostRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('posts')
    .select(POST_COLUMNS)
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data) return null;
  const post = data as unknown as PostRow;

  // Only the manager learns whose row this is.
  const revealMembers = canSeeMembers(profile);
  if (revealMembers) {
    const owners = await loadOwners([post.user_id]);
    post.owner = owners.get(post.user_id) ?? null;
  }

  const [withTranslations] = await attachTranslations([post], revealMembers);
  return withTranslations ?? post;
}

/**
 * Fetches posts for export. Deliberately not paged: an export covers the
 * whole filtered set. The archive is text, so several thousand rows still
 * build comfortably in memory, and the cap is surfaced to the caller
 * rather than silently truncating.
 */
export const EXPORT_ROW_LIMIT = 20000;

export async function listPostsForExport(
  profile: Profile,
  filters: Omit<PostFilters, 'page' | 'pageSize'>
): Promise<PostRow[]> {
  const supabase = await createClient();
  const search = (filters.q ? buildSearchFilter(filters.q) : null) ?? SEARCH_ALL;
  const scoped = { ...filters, owner: scopeToUserId(profile, filters.owner) ?? undefined };

  const languageIds = await postIdsTranslatedInto(filters.language);
  if (languageIds && languageIds.length === 0) return [];

  const base = supabase
    .from('posts')
    .select(POST_COLUMNS)
    .is('deleted_at', null)
    .or(search);

  const { data, error } = await applyPostFilters(base, scoped, languageIds ?? undefined).limit(EXPORT_ROW_LIMIT);

  if (error) throw new Error('تعذر تحضير البيانات للتصدير: ' + error.message);

  let rows = (data ?? []) as unknown as PostRow[];

  // Member identities are only attached for the manager, for the same
  // reason as in listPosts.
  const enrichOwners = canSeeMembers(profile);
  if (enrichOwners && rows.length > 0) {
    const owners = await loadOwners(rows.map((row) => row.user_id));
    rows = rows.map((row) => ({ ...row, owner: owners.get(row.user_id) ?? null }));
  }

  return attachTranslations(rows, enrichOwners);
}

// ---------------------------------------------------------------------
// Mutations (service client + rbac checks at the call site)
// ---------------------------------------------------------------------

/** Applies dashboard edits to a post. Caller must have checked canEditPost. */
export async function updatePostByEditor(
  postId: string,
  patch: { editor_note?: string; status?: string; privacy?: string; author?: string; post_date?: string; post_time?: string }
): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.from('posts').update(patch).eq('id', postId);
  if (error) throw new Error('تعذر تحديث المنشور: ' + error.message);
}

/**
 * Saves an in-app Markdown edit — the مناقيش equivalent of the
 * extension's own Markdown editor.
 *
 * Written through the service client because an editor or the manager
 * must be able to edit rows they do not own. The caller is responsible
 * for having checked `canEditPost` first.
 *
 * Passing empty strings clears the override, so the post falls back to
 * exactly what the extension originally saved.
 */
export async function updatePostContent(
  postId: string,
  input: { markdown: string; text: string; editorId: string; status?: string }
): Promise<void> {
  const service = createServiceClient();
  const markdown = input.markdown.trim();
  const text = input.text.trim();
  const isClearing = markdown.length === 0 && text.length === 0;

  const { error } = await service
    .from('posts')
    .update({
      edited_markdown: isClearing ? null : markdown,
      edited_text: isClearing ? null : text,
      edited_at: isClearing ? null : new Date().toISOString(),
      edited_by: isClearing ? null : input.editorId,
      // Only present when the caller is allowed to change the state, and
      // only when they actually chose one.
      ...(input.status ? { status: input.status } : {})
    })
    .eq('id', postId);

  if (error) throw new Error('تعذر حفظ التعديل: ' + error.message);
}

/**
 * Soft-deletes a post so the manager keeps an audit trail.
 * (The extension's own DELETE removes its row outright; that is the
 * member withdrawing a post from their own device.)
 */
export async function softDeletePost(postId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from('posts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', postId);
  if (error) throw new Error('تعذر حذف المنشور: ' + error.message);
}

export async function restorePost(postId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.from('posts').update({ deleted_at: null }).eq('id', postId);
  if (error) throw new Error('تعذر استعادة المنشور: ' + error.message);
}

// ---------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------

/**
 * The shared language list. Arabic is the source language and is NOT a
 * translation target, so it is not stored here.
 */
export async function listLanguages(): Promise<LanguageRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('languages')
    .select('code,name_ar,name_en,is_default,created_at')
    .order('name_ar', { ascending: true });

  if (error) return [];
  return (data ?? []) as LanguageRow[];
}

/** Adds a language. Returns the existing row version when present. */
export async function upsertLanguage(input: {
  code: string;
  nameAr: string;
  nameEn: string;
  createdBy: string;
}): Promise<LanguageRow> {
  const service = createServiceClient();

  const { data: existing } = await service
    .from('languages')
    .select('code,name_ar,name_en,is_default,created_at')
    .eq('code', input.code)
    .maybeSingle();

  if (existing) return existing as LanguageRow;

  const { data, error } = await service
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
  const service = createServiceClient();
  const { error } = await service.from('languages').delete().eq('code', code);
  if (error) throw new Error('تعذر حذف اللغة: ' + error.message);
}

export async function countTranslationsForLanguage(code: string): Promise<number> {
  const service = createServiceClient();
  const { count } = await service
    .from('translations')
    .select('id', { count: 'exact', head: true })
    .eq('language_code', code);
  return count ?? 0;
}

// ---------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------

/**
 * Creates or replaces the translation of one post in one language.
 *
 * This is the "أضف ترجمة" button: the first translator to use a new
 * language names it, which registers the language for everyone; later
 * translators (or the same one) press a button for another language and
 * a second translation row is created alongside the first.
 */
export async function upsertTranslation(input: {
  postId: string;
  languageCode: string;
  title: string;
  translatedText: string;
  bodyMarkdown: string;
  translatorId: string;
  isComplete: boolean;
}): Promise<TranslationRow> {
  const service = createServiceClient();

  const { data, error } = await service
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
    .select('id,post_id,language_code,title,translated_text,body_markdown,translator_id,is_complete,created_at,updated_at')
    .single();

  if (error) throw new Error('تعذر حفظ الترجمة: ' + error.message);
  return data as TranslationRow;
}

export async function deleteTranslation(translationId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.from('translations').delete().eq('id', translationId);
  if (error) throw new Error('تعذر حذف الترجمة: ' + error.message);
}

/**
 * Reads the fields needed to decide whether a translation may be removed.
 * Uses the service client because the caller is already authorized by
 * lib/rbac.ts and needs to see other members' rows to judge ownership.
 */
export async function getTranslationForDelete(
  translationId: string
): Promise<{ id: string; translator_id: string | null; language_code: string; is_complete: boolean } | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('translations')
    .select('id,translator_id,language_code,is_complete')
    .eq('id', translationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as { id: string; translator_id: string | null; language_code: string; is_complete: boolean };
}

/** Which languages already have a translation for each post. */
export async function translationCountsByLanguage(): Promise<Record<string, number>> {
  const service = createServiceClient();
  const { data, error } = await service.from('translations').select('language_code');
  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data as { language_code: string }[]) {
    counts[row.language_code] = (counts[row.language_code] ?? 0) + 1;
  }
  return counts;
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
  const service = createServiceClient();
  const seesAll = canSeeAllPosts(profile);

  // Post counts and the id list that scopes the translation count. A
  // collector's dashboard must never report the team-wide totals.
  let postsQuery = service.from('posts').select('id', { count: 'exact' }).is('deleted_at', null);
  if (!seesAll) postsQuery = postsQuery.eq('user_id', profile.id);

  const [postsResult, languagesResult, membersResult] = await Promise.all([
    postsQuery,
    service.from('languages').select('code', { count: 'exact', head: true }),
    // Member figures are only ever displayed to the manager, who is the
    // only role allowed to see them.
    seesAll ? service.from('profiles').select('status') : Promise.resolve({ data: [] as { status: string }[] })
  ]);

  const visibleIds = ((postsResult.data ?? []) as { id: string }[]).map((row) => row.id);

  // Count only posts that actually have at least one translation, and
  // only within the rows this viewer is allowed to see.
  let translatedPosts = 0;
  if (visibleIds.length > 0) {
    const { data: translationRows } = await service
      .from('translations')
      .select('post_id')
      .in('post_id', visibleIds);
    translatedPosts = new Set(((translationRows ?? []) as { post_id: string }[]).map((row) => row.post_id)).size;
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

export { PRIVACY_LABELS };
export type { PostRow, TranslationRow };
