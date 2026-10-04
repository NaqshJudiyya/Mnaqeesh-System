'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PRIVACY_LABELS,
  POST_STATUSES,
  POST_STATUS_LABELS,
  derivePostStatus,
  resolvePostContent,
  type LanguageRow,
  type PostRow,
  type PostsPage,
  type StatusVariant,
  type TranslationRow
} from '@/lib/types';
import type { Profile } from '@/lib/rbac';
import Modal from '@/components/modal';
import MarkdownEditor from '@/components/markdown-editor';
import ImportPanel from '@/components/import-panel';
import {
  getPost,
  listPosts,
  restorePosts,
  runBulkAction,
  softDeletePosts,
  updatePost,
  addLanguage,
  deleteTranslation,
  upsertTranslation
} from '@/lib/client/posts';
import { logActivity } from '@/lib/client/session';

type Member = { id: string; full_name: string; email: string };

type Props = {
  viewer: Profile;
  /** Only supplied for the manager, who is the only one allowed to see members. */
  members: Member[];
  languages: LanguageRow[];
  /** Post ids by language, for the header's translation filter. */
  translationCounts: Record<string, number>;
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function languageName(languages: LanguageRow[], code: string): string {
  const language = languages.find((item) => item.code === code);
  return language ? language.name_ar || language.name_en || code : code.toUpperCase();
}

/**
 * The Markdown to load into the editor.
 *
 * The extension stores `markdownText` empty until someone edits the post
 * inside the extension, so a freshly saved post has only raw `text`.
 * Seeding the editor with `.markdown` alone therefore opened an EMPTY
 * editor for those posts. Falling back to `text` means the editor always
 * starts from the content that is actually visible in the table.
 */
function editorSeed(post: PostRow): string {
  const content = resolvePostContent(post);
  return content.markdown || content.text || '';
}

/** The badge shown in the status column, derived + manual combined. */
function statusOf(post: PostRow) {
  return derivePostStatus(post, (post.translations ?? []).length > 0);
}

/**
 * Optional view filters for the DERIVED part of the status.
 *
 * These cannot be sent to the database: «منسَّق» and «مترجَم» are computed
 * from the row (its markdown and its translations), not stored. So they
 * narrow the current page instead. The manual states — نهائي and يحتاج
 * مراجعة — do live in the `status` column and are filtered in the header.
 */
const VIEW_FILTERS: { value: 'all' | StatusVariant; label: string }[] = [
  { value: 'all', label: 'الكل' },
  { value: 'new', label: 'جديد' },
  { value: 'formatted', label: 'منسَّق' },
  { value: 'translated', label: 'مترجَم' },
  { value: 'final', label: 'نهائي' },
  { value: 'review', label: 'يحتاج مراجعة' }
];

/** A compact dropdown for a table column header. */
function HeaderSelect({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="th-select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      title={label}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------
// Media cell: the same URLs the extension stores in `image_urls` /
// `video_url` (not the CDN `*_direct_*` copies). The visible text is
// «صورة» / «فيديو»; the href is the original Facebook URL.
// ---------------------------------------------------------------------

function httpUrls(value: string[] | string | null | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function MediaCell({ post }: { post: PostRow }) {
  // Same field the extension shows. Direct CDN URLs are a different link.
  const storedImages = httpUrls(post.image_urls);
  const storedVideo = httpUrls(post.video_url);
  const imageUrls = storedImages.length ? storedImages : httpUrls(post.image_direct_urls);
  const videoUrls = storedVideo.length ? storedVideo : httpUrls(post.video_direct_url);

  if (imageUrls.length === 0 && videoUrls.length === 0) {
    return <span className="cell-muted">لا وسائط</span>;
  }

  return (
    <div className="media-cell">
      {imageUrls.length > 0 && (
        <ul className="media-links">
          {imageUrls.map((url, index) => (
            <li key={`image-${url}-${index}`}>
              <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                {imageUrls.length === 1 ? 'صورة' : `صورة ${index + 1}`}
              </a>
            </li>
          ))}
        </ul>
      )}

      {videoUrls.length > 0 && (
        <ul className="media-links">
          {videoUrls.map((url, index) => (
            <li key={`video-${url}-${index}`}>
              <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                {videoUrls.length === 1 ? 'فيديو' : `فيديو ${index + 1}`}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PostsClient({ viewer, members, languages, translationCounts }: Props) {
  const [data, setData] = useState<PostsPage>({ rows: [], total: 0, page: 1, pageSize: 50 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);

  // Filters, each rendered inside its own column header.
  const [textQuery, setTextQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [owner, setOwner] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [status, setStatus] = useState('');
  const [language, setLanguage] = useState('');
  const [viewStatus, setViewStatus] = useState<'all' | StatusVariant>('all');

  // Trash view (سلة المهملات): soft-deleted rows instead of live ones.
  const [trashMode, setTrashMode] = useState(false);

  // Multi-select for the bulk actions.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkAuthor, setBulkAuthor] = useState('');

  // Single-post author correction (manager only).
  const [authorEdit, setAuthorEdit] = useState<PostRow | null>(null);
  const [authorValue, setAuthorValue] = useState('');
  const [authorBusy, setAuthorBusy] = useState(false);

  // Modals
  const [editPost, setEditPost] = useState<PostRow | null>(null);
  const [translatePost, setTranslatePost] = useState<PostRow | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const mounted = useRef(true);

  const isManager = viewer.role === 'admin';
  // Translators hold no power over original posts, so they get no
  // selection column and no bulk bar at all.
  const canBulk = isManager || viewer.role === 'editor' || viewer.role === 'collector';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(textQuery.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [textQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const postsPage = await listPosts(viewer, {
        page,
        pageSize: 50,
        q: debouncedQuery || undefined,
        owner: owner || undefined,
        privacy: privacy || undefined,
        status: status || undefined,
        language: language || undefined,
        trash: trashMode
      });
      if (mounted.current) setData(postsPage);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'تعذر تحميل المنشورات.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [viewer, page, debouncedQuery, owner, privacy, status, language, trashMode]);

  useEffect(() => {
    void load();
  }, [load]);

  // The selection is page-bound: any change of view or filters starts a
  // fresh selection so a bulk action can never hit an invisible row.
  useEffect(() => {
    setSelected(new Set());
    setBulkStatus('');
    setBulkAuthor('');
  }, [page, debouncedQuery, owner, privacy, status, language, trashMode]);

  /** Replaces one row in place so the table updates without a full reload. */
  function patchRow(postId: string, patch: Partial<PostRow>) {
    setData((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.id === postId ? { ...row, ...patch } : row))
    }));
  }

  async function refreshAfterMutation(postId: string, message: string) {
    setNotice(message);
    // Pull the authoritative row (with translations) so counts stay right.
    try {
      const post = await getPost(viewer, postId);
      if (post) {
        patchRow(postId, post);
        return;
      }
    } catch {
      // Fall through to a full list reload.
    }
    void load();
  }

  async function deletePost(post: PostRow) {
    if (!window.confirm('سيتم نقل المنشور إلى سلة المهملات. هل تريد المتابعة؟')) return;
    try {
      const changed = await softDeletePosts([post.id]);
      if (changed === 0) throw new Error('لا تملك صلاحية حذف هذا المنشور.');
      setData((current) => ({
        ...current,
        rows: current.rows.filter((row) => row.id !== post.id),
        total: Math.max(0, current.total - 1)
      }));
      setNotice('تم نقل المنشور إلى سلة المهملات. يمكنك استعادته من زر «سلة المهملات».');
      void logActivity({
        action: 'post.delete',
        entity: 'posts',
        entityId: post.id,
        details: { author: (post.author || '').slice(0, 200) }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حذف المنشور.');
    }
  }

  async function restorePost(post: PostRow) {
    try {
      const changed = await restorePosts([post.id]);
      if (changed === 0) throw new Error('لا تملك صلاحية استعادة هذا المنشور.');
      setData((current) => ({
        ...current,
        rows: current.rows.filter((row) => row.id !== post.id),
        total: Math.max(0, current.total - 1)
      }));
      setNotice('تمت استعادة المنشور وعاد إلى قائمة المنشورات.');
      void logActivity({ action: 'post.restore', entity: 'posts', entityId: post.id, details: {} });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر استعادة المنشور.');
    }
  }

  async function saveAuthor() {
    if (!authorEdit) return;
    setAuthorBusy(true);
    setError('');
    try {
      const changed = await updatePost(authorEdit.id, { author: authorValue });
      if (changed === 0) throw new Error('تعذر تغيير صاحب البوست — تحقق من صلاحياتك.');
      patchRow(authorEdit.id, { author: authorValue });
      setAuthorEdit(null);
      setNotice('تم تغيير صاحب البوست (حساب فيسبوك).');
      void logActivity({
        action: 'post.author_change',
        entity: 'posts',
        entityId: authorEdit.id,
        details: { previousAuthor: authorEdit.author, author: authorValue }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تغيير صاحب البوست.');
    } finally {
      setAuthorBusy(false);
    }
  }

  async function runBulk(action: 'status' | 'delete' | 'restore' | 'author') {
    const ids = [...selected];
    if (ids.length === 0) return;

    if (action === 'delete') {
      const ok = window.confirm(`سيتم نقل ${ids.length} منشورًا إلى سلة المهملات. هل تريد المتابعة؟`);
      if (!ok) return;
    }

    setBulkBusy(true);
    setError('');
    try {
      const result = await runBulkAction(viewer, {
        action,
        ids,
        ...(action === 'status' ? { status: bulkStatus } : {}),
        ...(action === 'author' ? { author: bulkAuthor } : {}),
        canEditRow: (row) => isManager || viewer.role === 'editor' || row.user_id === viewer.id,
        canDeleteRow: (row) => isManager || viewer.role === 'editor' || row.user_id === viewer.id
      });

      setSelected(new Set());
      const skippedNote = result.skipped > 0 ? ` · تُوفي ${result.skipped} منشورًا لا تملك صلاحية عليه` : '';
      const messages: Record<typeof action, string> = {
        status: `تم تغيير حالة ${result.updated} منشورًا${skippedNote}.`,
        delete: `تم نقل ${result.updated} منشورًا إلى سلة المهملات${skippedNote}.`,
        restore: `تمت استعادة ${result.updated} منشورًا${skippedNote}.`,
        author: `تم تغيير صاحب البوست في ${result.updated} منشورًا${skippedNote}.`
      };
      setNotice(messages[action]);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ الإجراء الجماعي.');
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleSelected(postId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const hasFilters = Boolean(debouncedQuery || owner || privacy || status || language || viewStatus !== 'all');

  /** Rows after the derived-status view filter. */
  const visibleRows = useMemo(
    () => (viewStatus === 'all' || trashMode ? data.rows : data.rows.filter((post) => statusOf(post).variant === viewStatus)),
    [data.rows, viewStatus, trashMode]
  );

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));

  function toggleSelectAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleRows.forEach((row) => next.delete(row.id));
      else visibleRows.forEach((row) => next.add(row.id));
      return next;
    });
  }

  const activeFilterChips = useMemo(() => {
    const chips: { label: string; clear: () => void }[] = [];
    if (debouncedQuery) chips.push({ label: `بحث: ${debouncedQuery}`, clear: () => { setTextQuery(''); setDebouncedQuery(''); } });
    if (owner) {
      const member = members.find((m) => m.id === owner);
      chips.push({ label: `العضو: ${member?.full_name || member?.email || owner}`, clear: () => setOwner('') });
    }
    if (privacy) chips.push({ label: `الجمهور: ${PRIVACY_LABELS[privacy] ?? privacy}`, clear: () => setPrivacy('') });
    if (status) chips.push({ label: `الحالة: ${POST_STATUS_LABELS[status] ?? status}`, clear: () => setStatus('') });
    if (language) chips.push({ label: `الترجمة: ${languageName(languages, language)}`, clear: () => setLanguage('') });
    if (viewStatus !== 'all' && !trashMode) {
      const label = VIEW_FILTERS.find((item) => item.value === viewStatus)?.label ?? viewStatus;
      chips.push({ label: `العرض: ${label}`, clear: () => setViewStatus('all') });
    }
    return chips;
  }, [debouncedQuery, owner, privacy, status, language, viewStatus, trashMode, members, languages]);

  const translatedLanguages = languages.filter((lang) => (translationCounts[lang.code] ?? 0) > 0);

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {activeFilterChips.length > 0 && (
        <div className="row filter-bar">
          <span className="muted">الفلاتر النشطة:</span>
          {activeFilterChips.map((chip) => (
            <button key={chip.label} type="button" className="chip active" onClick={chip.clear} title="إزالة الفلتر">
              {chip.label} ✕
            </button>
          ))}
          <button
            type="button"
            className="btn secondary small"
            onClick={() => {
              setTextQuery('');
              setOwner('');
              setPrivacy('');
              setStatus('');
              setLanguage('');
              setViewStatus('all');
              setPage(1);
            }}
          >
            مسح الكل
          </button>
        </div>
      )}

      <div className="row filter-bar" style={{ justifyContent: 'space-between' }}>
        {trashMode ? (
          <span className="row" style={{ gap: 6 }}>
            <strong>🗑 سلة المهملات</strong>
            <span className="muted">المنشورات المحذوفة فقط — استعادتها تُعيدها إلى القائمة.</span>
          </span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <span className="muted">الحالة:</span>
            {VIEW_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`chip ${viewStatus === item.value ? 'active' : ''}`}
                onClick={() => setViewStatus(item.value)}
                title={
                  item.value === 'formatted'
                    ? 'منشورات عُدّل نصها أو لها نسخة Markdown'
                    : item.value === 'translated'
                      ? 'منشورات لها ترجمة'
                      : item.value === 'final'
                        ? 'حدّدها المدير أو صاحب المنشور كنهائية'
                        : item.value === 'review'
                          ? 'حدّدها المدير أو صاحب المنشور كتحتاج مراجعة'
                          : 'بدون فلتر حالة'
                }
              >
                {item.label}
              </button>
            ))}
            {viewStatus !== 'all' && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                (داخل الصفحة الحالية)
              </span>
            )}
          </span>
        )}

        <span className="row" style={{ gap: 8 }}>
          {!trashMode && (
            <button
              type="button"
              className="btn secondary small"
              onClick={() => { setShowImport(true); setNotice(''); setError(''); }}
              title="استيراد ملف JSON صدّرته الإضافة"
            >
              ⬆ استيراد JSON
            </button>
          )}
          {canBulk && (
            <button
              type="button"
              className={`btn small ${trashMode ? '' : 'secondary'}`}
              onClick={() => {
                // The manual-status dropdown is hidden inside the trash,
                // so a stale filter must not keep filtering silently.
                setTrashMode((value) => !value);
                setStatus('');
                setViewStatus('all');
                setPage(1);
              }}
              title={trashMode ? 'العودة إلى قائمة المنشورات' : 'عرض المنشورات المحذوفة لاستعادتها'}
            >
              {trashMode ? '↩ العودة إلى المنشورات' : '🗑 سلة المهملات'}
            </button>
          )}
        </span>
      </div>

      {/* ---------------- bulk selection bar ---------------- */}
      {canBulk && selected.size > 0 && (
        <div className="row filter-bar bulk-bar" style={{ justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 8 }}>
            <strong>تم تحديد {selected.size} منشورًا</strong>

            {trashMode ? (
              <button type="button" className="btn small" disabled={bulkBusy} onClick={() => void runBulk('restore')}>
                ♻ استعادة المحدد
              </button>
            ) : (
              <>
                <span className="row" style={{ gap: 4 }}>
                  <select
                    className="select"
                    style={{ padding: '4px 8px', fontSize: 13 }}
                    value={bulkStatus}
                    onChange={(event) => setBulkStatus(event.target.value)}
                    aria-label="تغيير حالة المحدد"
                  >
                    <option value="">غيّر الحالة إلى…</option>
                    {POST_STATUSES.map((value) => (
                      <option key={value} value={value}>{POST_STATUS_LABELS[value]}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn small"
                    disabled={bulkBusy || !bulkStatus}
                    onClick={() => void runBulk('status')}
                  >
                    تطبيق
                  </button>
                </span>

                {isManager && (
                  <span className="row" style={{ gap: 4 }}>
                    <input
                      className="input"
                      style={{ padding: '4px 8px', fontSize: 13, width: 200 }}
                      placeholder="صاحب البوست (حساب فيسبوك)…"
                      value={bulkAuthor}
                      onChange={(event) => setBulkAuthor(event.target.value)}
                      aria-label="تعيين صاحب البوست للمحدد"
                    />
                    <button
                      type="button"
                      className="btn small"
                      disabled={bulkBusy}
                      onClick={() => void runBulk('author')}
                      title="تغيير صاحب البوست (حساب فيسبوك) لكل المنشورات المحددة"
                    >
                      تعيين
                    </button>
                  </span>
                )}

                <button type="button" className="btn danger small" disabled={bulkBusy} onClick={() => void runBulk('delete')}>
                  🗑 حذف المحدد
                </button>
              </>
            )}
          </span>
          <button type="button" className="btn secondary small" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
            ✕ إلغاء التحديد
          </button>
        </div>
      )}

      <section className="card table-wrap">
        {loading ? (
          <div className="empty">جارٍ تحميل المنشورات…</div>
        ) : data.rows.length === 0 ? (
          <div className="empty">
            {trashMode
              ? 'سلة المهملات فارغة.'
              : hasFilters
                ? 'لا توجد منشورات مطابقة للفلاتر.'
                : 'لا توجد منشورات محفوظة بعد.'}
            {!trashMode && viewer.role === 'collector' && !hasFilters && (
              <>
                <br />
                <span className="muted">احفظ منشورات من فيسبوك عبر الإضافة وستظهر هنا.</span>
              </>
            )}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="empty">لا توجد منشورات بهذه الحالة في الصفحة الحالية.</div>
        ) : (
          <table className="posts-table">
            <thead>
              <tr>
                {canBulk && (
                  <th className="th-check">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      aria-label="تحديد كل صفوف الصفحة"
                      title="تحديد كل صفوف الصفحة"
                    />
                  </th>
                )}
                <th className="th-num">#</th>
                {isManager && (
                  <th className="th-owner">
                    العضو
                    <HeaderSelect
                      label="كل الأعضاء"
                      value={owner}
                      onChange={(next) => { setOwner(next); setPage(1); }}
                      options={members.map((member) => ({
                        value: member.id,
                        label: member.full_name || member.email
                      }))}
                    />
                  </th>
                )}
                <th>الحساب</th>
                <th className="th-date">تاريخ المنشور</th>
                <th className="th-privacy">
                  الجمهور
                  <HeaderSelect
                    label="الكل"
                    value={privacy}
                    onChange={(next) => { setPrivacy(next); setPage(1); }}
                    options={[
                      { value: 'public', label: 'عام' },
                      { value: 'friends', label: 'للأصدقاء' },
                      { value: 'private', label: 'أنا فقط' },
                      { value: 'unknown', label: 'غير معروف' }
                    ]}
                  />
                </th>
                <th className="th-text">
                  النص
                  <input
                    className="th-input"
                    value={textQuery}
                    onChange={(event) => setTextQuery(event.target.value)}
                    placeholder="بحث في النص…"
                    aria-label="بحث في نص المنشور"
                  />
                </th>
                <th className="th-media">الوسائط</th>
                <th className="th-lang">
                  الترجمات
                  <HeaderSelect
                    label="كل اللغات"
                    value={language}
                    onChange={(next) => { setLanguage(next); setPage(1); }}
                    options={translatedLanguages.map((lang) => ({
                      value: lang.code,
                      label: `${lang.name_ar || lang.code} (${translationCounts[lang.code] ?? 0})`
                    }))}
                  />
                </th>
                <th className="th-status">
                  {trashMode ? 'وقت الحذف' : 'الحالة'}
                  {!trashMode && (
                    <HeaderSelect
                      label="الكل"
                      value={status}
                      onChange={(next) => { setStatus(next); setPage(1); }}
                      options={POST_STATUSES.map((value) => ({
                        value,
                        label: POST_STATUS_LABELS[value]
                      }))}
                    />
                  )}
                </th>
                <th className="th-actions">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((post, index) => {
                const content = resolvePostContent(post);
                const translations = post.translations ?? [];
                const canEdit = isManager || viewer.role === 'editor' || post.user_id === viewer.id;
                const canDelete = isManager || viewer.role === 'editor' || post.user_id === viewer.id;

                return (
                  <tr key={post.id}>
                    {canBulk && (
                      <td className="td-check">
                        <input
                          type="checkbox"
                          checked={selected.has(post.id)}
                          onChange={() => toggleSelected(post.id)}
                          aria-label={`تحديد منشور ${post.author || post.post_key}`}
                        />
                      </td>
                    )}
                    <td className="cell-muted">{(data.page - 1) * data.pageSize + index + 1}</td>
                    {isManager && (
                      <td>
                        <div className="cell-title">{post.owner?.full_name || '—'}</div>
                        <div className="cell-muted">{post.owner?.email || '—'}</div>
                      </td>
                    )}
                    <td>
                      <div className="cell-title">
                        {post.author || 'غير معروف'}
                        {/* صاحب البوست (حساب فيسبوك) — تصحيح من المدير فقط.
                            مستخدم حفظ المنشور نفسه لا يمكن تغييره لأحد. */}
                        {isManager && !trashMode && (
                          <button
                            type="button"
                            className="icon-action inline-edit"
                            title="تغيير صاحب البوست (حساب فيسبوك)"
                            aria-label="تغيير صاحب البوست (حساب فيسبوك)"
                            onClick={() => { setAuthorEdit(post); setAuthorValue(post.author ?? ''); setNotice(''); }}
                          >
                            ✏️
                          </button>
                        )}
                      </div>
                      <div className="cell-muted">{formatDateTime(post.saved_at)}</div>
                    </td>
                    <td>
                      <div>{post.post_date || '—'}</div>
                      <div className="cell-muted">{post.post_time || '—'}</div>
                    </td>
                    <td>
                      <span className="badge">{PRIVACY_LABELS[post.privacy] ?? PRIVACY_LABELS.unknown}</span>
                    </td>
                    <td>
                      <div className="cell-text">{content.markdown || content.text || '—'}</div>
                      {content.isEdited && <span className="badge edited" style={{ marginTop: 4 }}>معدَّل</span>}
                    </td>
                    <td>
                      <MediaCell post={post} />
                    </td>
                    <td>
                      {translations.length > 0 ? (
                        <div className="lang-chips">
                          {translations.map((translation) => (
                            <span
                              key={translation.id}
                              className="badge lang"
                              title={translation.is_complete ? 'مكتملة' : 'غير مكتملة'}
                            >
                              {languageName(languages, translation.language_code)}
                              {translation.is_complete ? ' ✓' : ''}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="cell-muted">لا توجد</span>
                      )}
                    </td>
                    <td>
                      {trashMode ? (
                        <span className="cell-muted">{formatDateTime(post.deleted_at)}</span>
                      ) : (
                        (() => {
                          const badge = statusOf(post);
                          return (
                            <span
                              className={`badge status-${badge.variant}`}
                              title={
                                badge.manual
                                  ? 'حالة يدوية حدّدها المدير أو صاحب المنشور'
                                  : badge.variant === 'formatted'
                                    ? 'عُدّل نصه أو له نسخة Markdown'
                                    : badge.variant === 'translated'
                                      ? 'له ترجمة'
                                      : 'محفوظ فقط، بلا تعديل ولا ترجمة'
                              }
                            >
                              {badge.label}
                            </span>
                          );
                        })()
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {trashMode ? (
                          canDelete && (
                            <button
                              type="button"
                              className="icon-action"
                              title="استعادة المنشور من سلة المهملات"
                              aria-label="استعادة المنشور من سلة المهملات"
                              onClick={() => void restorePost(post)}
                            >
                              ♻
                            </button>
                          )
                        ) : (
                          <>
                            {canEdit && (
                              <button
                                type="button"
                                className="icon-action"
                                title="تحرير Markdown"
                                aria-label="تحرير Markdown"
                                onClick={() => { setEditPost(post); setNotice(''); }}
                              >
                                ✏️
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-action"
                              title="إضافة ترجمة"
                              aria-label="إضافة ترجمة"
                              onClick={() => { setTranslatePost(post); setNotice(''); }}
                            >
                              🌐
                            </button>
                            {post.post_url && (
                              <a
                                className="icon-action"
                                href={post.post_url}
                                target="_blank"
                                rel="noreferrer noopener"
                                title="فتح المنشور على فيسبوك"
                                aria-label="فتح المنشور على فيسبوك"
                              >
                                ↗
                              </a>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                className="icon-action danger"
                                title="حذف المنشور"
                                aria-label="حذف المنشور"
                                onClick={() => void deletePost(post)}
                              >
                                🗑
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {data.total > data.pageSize && (
          <div className="pager">
            <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              السابق
            </button>
            <span className="muted">
              الصفحة {data.page} من {totalPages} · {data.total} {trashMode ? 'منشور محذوف' : 'منشور'}
            </span>
            <button className="btn secondary small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              التالي
            </button>
          </div>
        )}
      </section>

      {/* ---------------- Markdown editor modal ---------------- */}
      <Modal
        open={editPost !== null}
        size="wide"
        title="محرّر Markdown"
        subtitle={
          editPost
            ? `${editPost.author || 'غير معروف'} · ${editPost.post_date || 'بدون تاريخ'} ${editPost.post_time || ''}`
            : undefined
        }
        onClose={() => {
          if (!editorBusy) setEditPost(null);
        }}
      >
        {editPost && (
          <MarkdownEditor
            postId={editPost.id}
            initialMarkdown={editorSeed(editPost)}
            originalMarkdown={editPost.markdown_text}
            originalText={editPost.text}
            isEdited={resolvePostContent(editPost).isEdited}
            /* The manager, an editor, or the member who saved the post —
               exactly the people allowed to change the manual state. */
            initialStatus={
              isManager || viewer.role === 'editor' || editPost.user_id === viewer.id
                ? editPost.status
                : undefined
            }
            onBusyChange={setEditorBusy}
            onSaved={async (markdown) => {
              const postId = editPost.id;
              setEditPost(null);
              await refreshAfterMutation(postId, 'تم حفظ التعديل داخل النظام.');
            }}
          />
        )}
      </Modal>

      {/* ---------------- change author (manager only) ---------------- */}
      <Modal
        open={authorEdit !== null}
        title="تغيير صاحب البوست"
        subtitle="حساب فيسبوك المنسوب إليه المنشور — متاح لمدير النظام فقط."
        onClose={() => { if (!authorBusy) setAuthorEdit(null); }}
      >
        {authorEdit && (
          <>
            <div className="notice">
              هذه هي «الحساب» الظاهرة في الجدول. لا يمكن تغيير <strong>العضو الذي حفظ المنشور</strong> —
              ذلك ثابت لكل منشور بعد الحفظ.
            </div>
            <div className="field">
              <label htmlFor="author-input">صاحب البوست (حساب فيسبوك)</label>
              <input
                id="author-input"
                className="input"
                style={{ width: '100%' }}
                value={authorValue}
                onChange={(event) => setAuthorValue(event.target.value)}
                maxLength={500}
                placeholder="اسم الحساب كما يظهر على فيسبوك"
              />
            </div>
            <div className="modal-foot" style={{ margin: '16px -18px -16px', borderRadius: '0 0 14px 14px' }}>
              <button className="btn secondary" onClick={() => setAuthorEdit(null)} disabled={authorBusy}>
                إلغاء
              </button>
              <button className="btn" onClick={() => void saveAuthor()} disabled={authorBusy}>
                {authorBusy ? 'جارٍ الحفظ…' : 'حفظ'}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* ---------------- Translation modal ---------------- */}
      <Modal
        open={translatePost !== null}
        size="wide"
        title="الترجمات"
        subtitle={
          translatePost
            ? `${translatePost.author || 'غير معروف'} · ${editorSeed(translatePost).slice(0, 60)}…`
            : undefined
        }
        onClose={() => setTranslatePost(null)}
      >
        {translatePost && (
          <TranslationPanel
            post={translatePost}
            viewerId={viewer.id}
            canOverride={isManager || viewer.role === 'editor'}
            languages={languages}
            onChanged={async (message) => {
              const postId = translatePost.id;
              await refreshAfterMutation(postId, message);
            }}
          />
        )}
      </Modal>

      {/* ---------------- import JSON modal ---------------- */}
      <Modal
        open={showImport}
        title="استيراد من JSON"
        subtitle="ارفع ملفًا صدّرته إضافة Facebook Post Saver"
        onClose={() => setShowImport(false)}
      >
        <ImportPanel
          onImported={() => {
            // Reload the current page so imported rows appear immediately.
            void load();
          }}
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------
// Translation panel (shown inside the modal)
// ---------------------------------------------------------------------

type Draft = { title: string; text: string; markdown: string; complete: boolean };

function draftFor(translations: TranslationRow[], code: string): Draft {
  const existing = translations.find((translation) => translation.language_code === code);
  return {
    title: existing?.title ?? '',
    text: existing?.translated_text ?? '',
    markdown: existing?.body_markdown ?? '',
    complete: existing?.is_complete ?? false
  };
}

function TranslationPanel({
  post,
  viewerId,
  canOverride,
  languages,
  onChanged
}: {
  post: PostRow;
  viewerId: string;
  /** True for the editor/manager, who may remove any translation. */
  canOverride: boolean;
  languages: LanguageRow[];
  onChanged: (message: string) => Promise<void> | void;
}) {
  const translations = useMemo(() => post.translations ?? [], [post]);
  const [activeLanguage, setActiveLanguage] = useState<string>(translations[0]?.language_code ?? '');
  const initial = draftFor(translations, translations[0]?.language_code ?? '');

  const [draftTitle, setDraftTitle] = useState(initial.title);
  const [draftText, setDraftText] = useState(initial.text);
  const [draftMarkdown, setDraftMarkdown] = useState(initial.markdown);
  const [draftComplete, setDraftComplete] = useState(initial.complete);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showAddLanguage, setShowAddLanguage] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

  const source = resolvePostContent(post);

  function selectLanguage(code: string, from: TranslationRow[] = translations) {
    const draft = draftFor(from, code);
    setActiveLanguage(code);
    setDraftTitle(draft.title);
    setDraftText(draft.text);
    setDraftMarkdown(draft.markdown);
    setDraftComplete(draft.complete);
    setError('');
    setNotice('');
    setShowAddLanguage(false);
  }

  async function saveTranslation() {
    if (!activeLanguage) {
      setError('اختر لغة أولًا.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await upsertTranslation({
        postId: post.id,
        languageCode: activeLanguage,
        title: draftTitle,
        translatedText: draftText,
        bodyMarkdown: draftMarkdown || draftText,
        translatorId: viewerId,
        isComplete: draftComplete
      });
      await logActivity({
        action: 'translation.save',
        entity: 'translations',
        entityId: post.id,
        details: { postId: post.id, language: activeLanguage }
      });
      setNotice(`تم حفظ ترجمة ${languageName(languages, activeLanguage)}.`);
      await onChanged(`تم حفظ ترجمة ${languageName(languages, activeLanguage)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ الترجمة.');
    } finally {
      setBusy(false);
    }
  }

  async function addLanguageAction() {
    setBusy(true);
    setError('');
    try {
      const language = await addLanguage({
        code: newCode,
        nameAr: newName,
        nameEn: newName,
        createdBy: viewerId
      });
      await logActivity({
        action: 'language.add',
        entity: 'languages',
        entityId: language.code,
        details: { nameAr: language.name_ar }
      });
      setNewCode('');
      setNewName('');
      setShowAddLanguage(false);
      selectLanguage(language.code, []);
      setDraftTitle('');
      setDraftText('');
      setDraftMarkdown('');
      setDraftComplete(false);
      setNotice(`أُضيفت اللغة ${language.name_ar}. اكتب الترجمة ثم احفظ.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إضافة اللغة.');
    } finally {
      setBusy(false);
    }
  }

  async function removeTranslation(translationId: string) {
    setBusy(true);
    setError('');
    try {
      const target = translations.find((t) => t.id === translationId);
      // A translator may only remove their own unfinished draft; the
      // database trigger (0007) enforces the same rule for any client.
      if (target && !canOverride) {
        if (target.translator_id !== viewerId) {
          throw new Error('لا يمكنك حذف ترجمة كتبها مترجم آخر.');
        }
        if (target.is_complete) {
          throw new Error('هذه الترجمة مكتملة، ولا يمكن حذفها إلا من محرر أو مدير النظام.');
        }
      }

      await deleteTranslation(translationId);
      await logActivity({
        action: 'translation.delete',
        entity: 'translations',
        entityId: translationId,
        details: { language: target?.language_code ?? '', wasComplete: target?.is_complete ?? false }
      });
      selectLanguage('', []);
      setNotice('تم حذف الترجمة.');
      await onChanged('تم حذف الترجمة.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الترجمة.');
    } finally {
      setBusy(false);
    }
  }

  const available = languages.filter(
    (language) => !translations.some((translation) => translation.language_code === language.code)
  );
  const activeTranslation = translations.find((t) => t.language_code === activeLanguage) ?? null;

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="field">
        <label>المحتوى الأصلي</label>
        <div className="post-body" style={{ maxHeight: 160 }}>{source.markdown || source.text || '—'}</div>
      </div>

      <div className="lang-chips" style={{ marginTop: 12 }}>
        {translations.map((translation) => (
          <button
            key={translation.id}
            type="button"
            className={`chip has-translation ${activeLanguage === translation.language_code ? 'active' : ''}`}
            onClick={() => selectLanguage(translation.language_code)}
          >
            {languageName(languages, translation.language_code)}
            {translation.is_complete ? ' ✓' : ''}
          </button>
        ))}
        {available.length > 0 && (
          <button type="button" className="chip add" onClick={() => setShowAddLanguage((v) => !v)}>
            + إضافة لغة
          </button>
        )}
      </div>

      {showAddLanguage && (
        <div className="translation-card" style={{ marginTop: 12 }}>
          <div className="row">
            <input
              className="input"
              style={{ width: 130 }}
              placeholder="الرمز (en)"
              value={newCode}
              onChange={(event) => setNewCode(event.target.value)}
              maxLength={12}
            />
            <input
              className="input grow"
              placeholder="اسم اللغة (الإنجليزية)"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={60}
            />
            <button className="btn small" onClick={addLanguageAction} disabled={busy || !newCode || !newName}>
              إضافة
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            الرمز بصيغة ISO مثل <code>en</code> أو <code>fr</code>. عند الإضافة تصبح اللغة متاحة لكل المنشورات.
          </p>
        </div>
      )}

      {activeLanguage ? (
        <div className="translation-card" style={{ marginTop: 12 }}>
          <div className="translation-head">
            <strong>ترجمة {languageName(languages, activeLanguage)}</strong>
            {activeTranslation && (
              <button
                className="btn danger small"
                onClick={() => void removeTranslation(activeTranslation.id)}
                disabled={busy}
              >
                حذف الترجمة
              </button>
            )}
          </div>

          <div className="field">
            <label htmlFor="tr-title">العنوان</label>
            <input
              id="tr-title"
              className="input"
              style={{ width: '100%' }}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={300}
            />
          </div>

          <div className="field">
            <label htmlFor="tr-text">نص الترجمة</label>
            <textarea
              id="tr-text"
              className="textarea"
              rows={8}
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              placeholder="اكتب الترجمة هنا…"
            />
          </div>

          <div className="row">
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={draftComplete}
                onChange={(event) => setDraftComplete(event.target.checked)}
              />
              <span className="muted">ترجمة مكتملة ومراجَعة</span>
            </label>
            <span className="grow" />
            <button className="btn" onClick={saveTranslation} disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ الترجمة'}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 12 }}>
          اختر لغة من الأعلى لتعديل ترجمتها، أو أضف لغة جديدة.
        </p>
      )}
    </>
  );
}
