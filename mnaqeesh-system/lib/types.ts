/**
 * Shared row/data types for the مناقيش dashboard.
 *
 * `PostRow` mirrors `public.posts` exactly as created by the migration.
 * The first block of fields is the contract with the browser extension
 * (Facebook Post Saver v2.13.0) and must never be renamed.
 */

export type PostRow = {
  id: string;
  user_id: string;
  /** Stable text key produced by the extension: fb:<id> | url:<url> | fp:<hash> */
  post_key: string;
  author: string;
  post_date: string;
  post_time: string;
  privacy: string;
  text: string;
  markdown_text: string;
  image_urls: string[];
  image_direct_urls: string[];
  video_url: string;
  video_direct_url: string;
  post_url: string;
  saved_at: string;
  // system extras
  status: string;
  editor_note: string;
  /**
   * Content edited INSIDE مناقيش. Null while the post still carries only
   * what the extension saved.
   *
   * Precedence used by the dashboard AND every export:
   *   edited_markdown ?? markdown_text, falling back to `text`.
   */
  edited_markdown: string | null;
  edited_text: string | null;
  edited_at: string | null;
  edited_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  /** Injected by the dashboard when an admin/editor views the pool. */
  owner?: { email: string; full_name: string; avatar_url: string } | null;
  translations?: TranslationRow[];
};

/**
 * Resolves the content to display or export for a post.
 *
 * A single helper so the dashboard, the exports, and the WordPress file
 * all agree: an in-app edit always wins over the scraped value.
 */
export function resolvePostContent(post: {
  edited_markdown?: string | null;
  edited_text?: string | null;
  markdown_text?: string | null;
  text?: string | null;
}): { markdown: string; text: string; isEdited: boolean } {
  const editedMarkdown = (post.edited_markdown ?? '').trim();
  const editedText = (post.edited_text ?? '').trim();

  if (editedMarkdown || editedText) {
    return {
      markdown: editedMarkdown,
      text: editedText || editedMarkdown,
      isEdited: true
    };
  }

  const markdown = (post.markdown_text ?? '').trim();
  const plain = (post.text ?? '').trim();
  return { markdown, text: plain || markdown, isEdited: false };
}

export type TranslationRow = {
  id: string;
  post_id: string;
  language_code: string;
  title: string;
  translated_text: string;
  body_markdown: string;
  translator_id: string | null;
  is_complete: boolean;
  created_at: string;
  updated_at: string;
  translator?: { full_name: string; email: string } | null;
};

export type LanguageRow = {
  code: string;
  name_ar: string;
  name_en: string;
  is_default: boolean;
  created_at: string;
};

export type ActivityRow = {
  id: number;
  actor_email: string;
  action: string;
  entity: string;
  entity_id: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type PostFilters = {
  q?: string;
  owner?: string;
  privacy?: string;
  status?: string;
  language?: string;
  /** Restricts the result to one specific post (used by single-post export). */
  postKey?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  sort?: 'newest' | 'oldest';
};

export type PostsPage = {
  rows: PostRow[];
  total: number;
  page: number;
  pageSize: number;
};

export const PRIVACY_LABELS: Record<string, string> = {
  public: 'عام',
  friends: 'للأصدقاء',
  private: 'أنا فقط',
  unknown: 'غير معروف'
};

// ---------------------------------------------------------------------
// Post status
//
// The status shown in the table is TWO things combined:
//
//   1. A DERIVED state, computed from the row itself — nobody sets it:
//        محفوظ فقط        -> «جديد»
//        عُدّل نصه بالـmd  -> «منسَّق»   (أصفر)
//        له ترجمة          -> «مترجَم»   (أزرق)
//
//   2. A MANUAL workflow state, which only the manager or the member who
//      saved the post may set:
//        نهائي            -> «نهائي»         (أخضر)
//        يحتاج مراجعة      -> «يحتاج مراجعة»  (أحمر)
//
// A manual state wins, because it is an explicit human judgement.
// ---------------------------------------------------------------------

/** The `posts.status` column holds only the manual part. */
export const MANUAL_STATUSES = ['new', 'final', 'needs_review'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export const MANUAL_STATUS_LABELS: Record<ManualStatus, string> = {
  new: 'عادي',
  final: 'نهائي',
  needs_review: 'يحتاج مراجعة'
};

export type StatusVariant = 'new' | 'formatted' | 'translated' | 'final' | 'review';

export type DerivedStatus = {
  /** Short badge text. */
  label: string;
  /** Drives the badge colour. */
  variant: StatusVariant;
  /** True when a human set it (so the UI can mark it as a decision). */
  manual: boolean;
};

/**
 * Works out the badge to show for a post.
 *
 * `hasTranslation` comes from the row's translations; `isEdited` comes
 * from `resolvePostContent`, i.e. whether the text was changed inside
 * مناقيش (the extension's own Markdown counts as "formatted" too, since
 * it is also a formatted version of the raw text).
 */
export function derivePostStatus(post: {
  status?: string | null;
  edited_markdown?: string | null;
  edited_text?: string | null;
  markdown_text?: string | null;
}, hasTranslation: boolean): DerivedStatus {
  const manual = String(post.status ?? 'new');

  if (manual === 'final') return { label: 'نهائي', variant: 'final', manual: true };
  if (manual === 'needs_review') return { label: 'يحتاج مراجعة', variant: 'review', manual: true };

  // Nothing manual: fall back to what the row actually contains.
  const formatted =
    Boolean((post.edited_markdown ?? '').trim()) ||
    Boolean((post.edited_text ?? '').trim()) ||
    Boolean((post.markdown_text ?? '').trim());

  if (formatted) return { label: 'منسَّق', variant: 'formatted', manual: false };
  if (hasTranslation) return { label: 'مترجَم', variant: 'translated', manual: false };
  return { label: 'جديد', variant: 'new', manual: false };
}

/** Kept for the status filter dropdown. */
export const POST_STATUS_LABELS: Record<string, string> = {
  new: 'جديد',
  final: 'نهائي',
  needs_review: 'يحتاج مراجعة'
};

export const POST_STATUSES = MANUAL_STATUSES;

export type ExportFormat = 'xlsx' | 'json' | 'markdown' | 'csv' | 'wxr';

/**
 * Export scope. Every language is exported separately, exactly as
 * requested: choosing a language exports only that language's version of
 * each post, never a mix.
 */
export type ExportScope =
  | { kind: 'source' }
  | { kind: 'language'; code: string };
