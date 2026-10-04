/**
 * Export builders.
 *
 * Everything here is keyed by LANGUAGE: the caller resolves each post to
 * exactly one language version (its translation in that language, or the
 * original source when exporting the source), so a single exported file
 * never mixes languages — which is the behaviour that was requested.
 *
 * Formats: XLSX, JSON, Markdown, CSV, and WordPress WXR.
 * The XLSX layout, the WXR structure, and the Markdown-to-HTML renderer
 * are faithful ports of the extension's own export code so that files
 * produced by مناقيش open identically in Excel and import identically
 * into WordPress.
 */

import { buildXlsx, type XlsxRow } from '@/lib/export/xlsx-writer';
import { buildZip, type ZipEntry } from '@/lib/export/zip-writer';
import { PRIVACY_LABELS, type ExportFormat, type PostRow } from '@/lib/types';

/** One post flattened into a single language version. */
export type ExportItem = {
  postId: string;
  postKey: string;
  /** Owner id, used to group a split export by member. */
  userId: string;
  /** Arabic (source) content. */
  sourceTitle: string;
  sourceText: string;
  sourceMarkdown: string;
  /** The selected language's content — equals the source for a source export. */
  title: string;
  text: string;
  markdown: string;
  /** '' for a source export, otherwise the target language code. */
  languageCode: string;
  languageName: string;
  author: string;
  date: string;
  time: string;
  privacy: string;
  imageUrls: string[];
  videoUrl: string;
  postUrl: string;
  savedAt: string;
  translatorName: string;
};

export type ExportResult = {
  filename: string;
  contentType: string;
  body: Buffer;
};

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

export function privacyLabel(value: string): string {
  return PRIVACY_LABELS[value] ?? PRIVACY_LABELS.unknown;
}

function xmlEscapeText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlCdata(value: unknown): string {
  return `<![CDATA[${String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** HTML-escapes text (the DOM-free equivalent of the extension's helper). */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeWordPressSlug(value: string): string {
  return (
    String(value || 'post')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80) || 'post'
  );
}

/**
 * Renders the subset of Markdown the extension writes, producing the
 * same HTML the extension's own preview/export produces.
 */
export function renderMarkdown(markdown: string): string {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '<p class="fps-md-empty-preview">لا يوجد محتوى.</p>';

  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const inline = (raw: string): string => {
    let x = escapeHtml(raw);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img alt="$1" src="$2">');
    x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

/** Removes Facebook's tracking parameters from a post URL. */
export function cleanFacebookPostUrl(rawUrl: string): string {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const tracking = new Set([
      'locale', 'mibextid', 'paipv', 'acontext', '__cft__', '__tn__',
      'ref', 'refsrc', 'comment_id', 'reply_comment_id', 'notif_id',
      'notif_t', 'eid', 'hc_ref', 'fref', 'pnref', 'ftentidentifier'
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (tracking.has(key) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = url.searchParams.toString();
    return query ? `${url.origin}${path}?${query}` : `${url.origin}${path}`;
  } catch {
    return value;
  }
}

/** Derives a WordPress title using the extension's precedence rules. */
export function deriveTitle(item: ExportItem, index: number): string {
  if (item.title.trim()) return item.title.trim().slice(0, 150);
  const source = String(item.markdown || item.text || '').replace(/\r\n?/g, '\n').trim();
  const heading = source.match(/^#{1,6}\s+(.+)$/m);
  if (heading?.[1]) {
    return heading[1].replace(/[*_`]/g, '').trim().slice(0, 150) || `منشور ${index + 1}`;
  }
  const firstBlock = source.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (firstBlock) return firstBlock.slice(0, 150);
  return `منشور ${index + 1} — ${item.date || 'بدون تاريخ'}`;
}

/** Parses the extension's D/M/YYYY + H:MM pair into a local Date. */
function parsePostDateTime(item: ExportItem): Date | null {
  const dm = String(item.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const tm = String(item.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!dm) return null;
  const year = Number(dm[3]);
  const month = Number(dm[2]);
  const day = Number(dm[1]);
  const hours = tm ? Number(tm[1]) : 0;
  const minutes = tm ? Number(tm[2]) : 0;
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWpLocal(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

function formatWpGmt(date: Date): string {
  const utc = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')} ${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}:00`;
}

// ---------------------------------------------------------------------
// WXR (WordPress)
// ---------------------------------------------------------------------

function buildWordPressPostHtml(item: ExportItem): string {
  const markdown = String(item.markdown || item.text || '').trim();
  let html = renderMarkdown(markdown);

  const images = (item.imageUrls || []).filter(Boolean);
  if (images.length) {
    html += '<p class="facebook-post-saver-images">';
    images.forEach((url, i) => {
      const safe = xmlEscapeText(url);
      html += `<a href="${safe}"><img src="${safe}" alt="صورة ${i + 1}" /></a>`;
    });
    html += '</p>';
  }

  if (item.videoUrl) {
    const safe = xmlEscapeText(item.videoUrl);
    html += `<p><a href="${safe}">فيديو المنشور</a></p>`;
  }

  const cleaned = cleanFacebookPostUrl(item.postUrl);
  if (cleaned) {
    const safe = xmlEscapeText(cleaned);
    html += `<hr /><p><strong>المصدر:</strong> <a href="${safe}">${safe}</a></p>`;
  }

  return html || '<p></p>';
}

function buildWordPressAuthor(): string {
  return `<wp:author>
      <wp:author_id>1</wp:author_id>
      <wp:author_login>${xmlCdata('mnaqeesh')}</wp:author_login>
      <wp:author_email>${xmlCdata('no-reply@example.invalid')}</wp:author_email>
      <wp:author_display_name>${xmlCdata('مناقيش')}</wp:author_display_name>
      <wp:author_first_name>${xmlCdata('')}</wp:author_first_name>
      <wp:author_last_name>${xmlCdata('')}</wp:author_last_name>
    </wp:author>`;
}

function buildWordPressPostItem(item: ExportItem, index: number, exportStamp: string, authorLogin: string): string {
  const postNumber = index + 1;
  const title = deriveTitle(item, index);
  const postDate = parsePostDateTime(item) ?? new Date();
  const local = formatWpLocal(postDate);
  const gmt = formatWpGmt(postDate);
  const contentHtml = buildWordPressPostHtml(item);
  const slug = sanitizeWordPressSlug(title);
  const guid = `mnaqeesh:${item.postKey || item.postId}`;
  const wxrSourceLink = `https://mnaqeesh.invalid/import/${encodeURIComponent(item.postId)}`;
  const sourceUrl = cleanFacebookPostUrl(item.postUrl);

  const meta: [string, string][] = [
    ['facebook_post_url', sourceUrl],
    ['facebook_account', item.author || ''],
    ['facebook_date', item.date || ''],
    ['facebook_time', item.time || ''],
    ['facebook_privacy', privacyLabel(item.privacy)],
    ['facebook_image_urls', JSON.stringify(item.imageUrls || [])],
    ['facebook_video_url', item.videoUrl || ''],
    ['facebook_saver_exported_at', exportStamp],
    // مناقيش additions
    ['mnaqeesh_language', item.languageCode || 'ar'],
    ['mnaqeesh_language_name', item.languageName || 'العربية'],
    ['mnaqeesh_translator', item.translatorName || ''],
    ['mnaqeesh_post_key', item.postKey || ''],
    ['mnaqeesh_source_text', item.sourceText || ''],
    ['mnaqeesh_saved_at', item.savedAt || '']
  ];

  const postmeta = meta
    .map(
      ([k, v]) =>
        `\n      <wp:postmeta><wp:meta_key>${xmlCdata(k)}</wp:meta_key><wp:meta_value>${xmlCdata(v)}</wp:meta_value></wp:postmeta>`
    )
    .join('');

  return `\n  <item>
    <title>${xmlCdata(title)}</title>
    <link>${xmlCdata(wxrSourceLink)}</link>
    <pubDate>${postDate.toUTCString()}</pubDate>
    <dc:creator>${xmlCdata(authorLogin)}</dc:creator>
    <guid isPermaLink="false">${xmlEscapeText(guid)}</guid>
    <description>${xmlCdata('Mnaqeesh import')}</description>
    <content:encoded>${xmlCdata(contentHtml)}</content:encoded>
    <excerpt:encoded>${xmlCdata('')}</excerpt:encoded>
    <wp:post_id>${postNumber}</wp:post_id>
    <wp:post_date>${xmlCdata(local)}</wp:post_date>
    <wp:post_date_gmt>${xmlCdata(gmt)}</wp:post_date_gmt>
    <wp:comment_status>${xmlCdata('closed')}</wp:comment_status>
    <wp:ping_status>${xmlCdata('closed')}</wp:ping_status>
    <wp:post_name>${xmlCdata(slug)}</wp:post_name>
    <wp:status>${xmlCdata('draft')}</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>${xmlCdata('post')}</wp:post_type>
    <wp:post_password>${xmlCdata('')}</wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>${postmeta}
  </item>`;
}

function buildWordPressWxr(items: ExportItem[]): string {
  const exportStamp = new Date().toISOString();
  const authorLogin = 'mnaqeesh';
  const body = items
    .map((item, index) => buildWordPressPostItem(item, index, exportStamp, authorLogin))
    .join('');

  // A made-up site URL stops WordPress from rewriting Facebook links on import.
  const siteUrl = 'https://mnaqeesh.invalid/';
  const language = items[0]?.languageCode || 'ar';

  return `<?xml version="1.0" encoding="UTF-8" ?>\n<rss version="2.0" xml:lang="${xmlEscapeText(language)}"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>${xmlCdata('مناقيش')}</title>
    <link>${xmlCdata(siteUrl)}</link>
    <description>${xmlCdata('Export created by Mnaqeesh')}</description>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <language>${xmlEscapeText(language)}</language>
    <wp:wxr_version>${xmlCdata('1.2')}</wp:wxr_version>
    <wp:base_site_url>${xmlCdata(siteUrl)}</wp:base_site_url>
    <wp:base_blog_url>${xmlCdata(siteUrl)}</wp:base_blog_url>
    ${buildWordPressAuthor()}${body}
  </channel>
</rss>\n`;
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

const CSV_HEADERS = [
  '#',
  'اللغة',
  'اسم الحساب',
  'التاريخ',
  'الوقت',
  'جمهور المنشور',
  'العنوان',
  'نص المنشور',
  'رابط الصورة / الصور',
  'رابط الفيديو',
  'رابط المنشور',
  'المترجم',
  'وقت الحفظ'
];

function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  // Always quote: post bodies contain newlines, commas, and quotes.
  return `"${raw.replace(/"/g, '""')}"`;
}

function buildCsv(items: ExportItem[]): string {
  const lines: string[] = [CSV_HEADERS.map(csvCell).join(',')];
  items.forEach((item, index) => {
    lines.push(
      [
        index + 1,
        item.languageName,
        item.author,
        item.date,
        item.time,
        privacyLabel(item.privacy),
        item.title,
        item.markdown || item.text,
        (item.imageUrls || []).join('\n'),
        item.videoUrl,
        item.postUrl,
        item.translatorName,
        item.savedAt
      ]
        .map(csvCell)
        .join(',')
    );
  });
  // Excel needs a BOM to read UTF-8 Arabic correctly.
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------

function buildJson(items: ExportItem[], scopeLabel: string, languageCode: string): string {
  const payload = {
    system: 'مناقيش',
    exportScope: languageCode || 'source',
    exportScopeLabel: scopeLabel,
    exportedAt: new Date().toISOString(),
    count: items.length,
    rows: items.map((item) => ({
      postKey: item.postKey,
      language: item.languageCode || 'ar',
      languageName: item.languageName,
      title: item.title,
      author: item.author,
      date: item.date,
      time: item.time,
      privacy: item.privacy,
      text: item.text,
      markdownText: item.markdown,
      sourceText: item.sourceText,
      sourceMarkdownText: item.sourceMarkdown,
      imageUrls: item.imageUrls,
      videoUrl: item.videoUrl,
      postUrl: item.postUrl,
      translator: item.translatorName,
      savedAt: item.savedAt
    }))
  };
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------

function buildMarkdown(items: ExportItem[], scopeLabel: string, languageCode: string): string {
  const parts: string[] = [
    `# مناقيش — ${scopeLabel}`,
    '',
    `- عدد المنشورات: ${items.length}`,
    `- اللغة: ${languageCode || 'ar'}`,
    `- تاريخ التصدير: ${new Date().toISOString()}`,
    ''
  ];

  items.forEach((item, index) => {
    parts.push('---', '', `## ${index + 1}. ${deriveTitle(item, index)}`, '');
    const meta: string[] = [
      `- **الحساب:** ${item.author || 'غير معروف'}`,
      `- **التاريخ:** ${item.date || '—'} ${item.time || ''}`.trim(),
      `- **الجمهور:** ${privacyLabel(item.privacy)}`,
      `- **اللغة:** ${item.languageName}`
    ];
    if (item.translatorName) meta.push(`- **المترجم:** ${item.translatorName}`);
    if (item.postUrl) meta.push(`- **رابط المنشور:** ${item.postUrl}`);
    parts.push(...meta, '');

    const body = String(item.markdown || item.text || '').trim();
    parts.push(body || '_لا يوجد محتوى._', '');

    if (item.imageUrls?.length) {
      parts.push('**الصور:**', '');
      item.imageUrls.forEach((url, i) => parts.push(`![صورة ${i + 1}](${url})`));
      parts.push('');
    }
    if (item.videoUrl) parts.push(`**الفيديو:** ${item.videoUrl}`, '');
  });

  return parts.join('\n');
}

// ---------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------

function toXlsxRows(items: ExportItem[]): XlsxRow[] {
  return items.map((item) => ({
    author: item.author,
    date: item.date,
    time: item.time,
    privacy: item.privacy,
    text: item.markdown || item.text,
    imageUrls: item.imageUrls || [],
    videoUrl: item.videoUrl,
    postUrl: item.postUrl
  }));
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'export';
}

export function buildExport(input: {
  items: ExportItem[];
  format: ExportFormat;
  languageCode: string;
  scopeLabel: string;
  /** Appended to the file name, e.g. `2026-03` or a member's name. */
  nameSuffix?: string;
}): ExportResult {
  const { items, format, languageCode, scopeLabel } = input;
  const stamp = new Date().toISOString().slice(0, 10);
  const langPart = languageCode ? sanitizeFilenamePart(languageCode) : 'source';
  const suffix = input.nameSuffix ? `-${sanitizeFilenamePart(input.nameSuffix)}` : '';
  const base = `mnaqeesh-${langPart}${suffix}-${stamp}`;

  switch (format) {
    case 'xlsx': {
      // Excel sheet names cannot contain []:*?/\ and are limited to 31 chars.
      const sheetName = (languageCode ? `Posts ${languageCode}` : 'Facebook Posts').slice(0, 31);
      return {
        filename: `${base}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: buildXlsx(toXlsxRows(items), sheetName)
      };
    }
    case 'csv':
      return {
        filename: `${base}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(buildCsv(items), 'utf8')
      };
    case 'json':
      return {
        filename: `${base}.json`,
        contentType: 'application/json; charset=utf-8',
        body: Buffer.from(buildJson(items, scopeLabel, languageCode), 'utf8')
      };
    case 'markdown':
      return {
        filename: `${base}.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: Buffer.from(buildMarkdown(items, scopeLabel, languageCode), 'utf8')
      };
    case 'wxr':
      return {
        filename: `${base}.xml`,
        contentType: 'application/xml; charset=utf-8',
        body: Buffer.from('\ufeff' + buildWordPressWxr(items), 'utf8')
      };
    default:
      throw new Error('صيغة التصدير غير مدعومة.');
  }
}

/** True when a post has a usable translation in the given language. */
export function findTranslation(post: PostRow, languageCode: string) {
  return (post.translations ?? []).find((t) => t.language_code === languageCode) ?? null;
}

// ---------------------------------------------------------------------
// Grouping for split exports
//
// Mirrors the extension's own `getPeriodInfo` / `groupRowsForExport` so a
// "file per year" export from مناقيش produces the same set of files the
// extension would have produced.
// ---------------------------------------------------------------------

export type ExportGroupMode = 'all' | 'year' | 'month' | 'account';

export type ExportGroup<T> = {
  /** Stable key: '', '2026', '2026-03', or a user id. */
  key: string;
  /** Human label used in the file name and at the top of the document. */
  label: string;
  rows: T[];
};

/**
 * Anything that can be filed under a period.
 *
 * `date` is the extension's `D/M/YYYY` field; `userId` is only needed for
 * the per-account split.
 */
export type DatedRow = {
  date?: string | null;
  userId?: string;
};

/**
 * Extracts the year and month from the extension's `D/M/YYYY` date field.
 *
 * Returns null when the date is missing or unparseable — those posts are
 * excluded from year/month splits, exactly as the extension does, because
 * guessing a period would silently file a post under the wrong month.
 */
export function periodInfo(row: DatedRow): { year: string; month: string } | null {
  const raw = String(row.date ?? '').trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year: String(year), month: `${year}-${String(month).padStart(2, '0')}` };
  }

  // Also accept an ISO-ish date, which older imports may carry.
  const iso = raw.match(/^(\d{4})-(\d{2})/);
  if (iso) return { year: iso[1], month: `${iso[1]}-${iso[2]}` };

  return null;
}

/** A safe file-name fragment built from a member's name. */
function safeLabel(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'account'
  );
}

/**
 * Splits rows into export files.
 *
 * `ownerLabels` maps a user id to a display name, used only for the
 * `account` mode.
 */
export function groupRows<T extends DatedRow>(
  rows: T[],
  mode: ExportGroupMode,
  ownerLabels: Map<string, string> = new Map()
): ExportGroup<T>[] {
  if (mode === 'all') {
    return rows.length ? [{ key: '', label: 'الكل', rows }] : [];
  }

  const groups = new Map<string, T[]>();

  for (const row of rows) {
    let key: string;

    if (mode === 'account') {
      key = row.userId || 'unknown';
    } else {
      const info = periodInfo(row);
      if (!info) continue; // undated -> cannot be filed under a period
      key = mode === 'year' ? info.year : info.month;
    }

    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    // Newest period first, like the extension; accounts sort by label.
    .sort(([a], [b]) => (mode === 'account' ? a.localeCompare(b) : b.localeCompare(a)))
    .map(([key, groupRows]) => {
      const label =
        mode === 'account'
          ? safeLabel(ownerLabels.get(key) ?? key.slice(0, 8))
          : key;
      return { key, label, rows: groupRows };
    });
}

/**
 * Builds a multi-file export and returns it as a single ZIP.
 *
 * Used whenever a split produces more than one file, so the manager gets
 * one download instead of a burst of pop-ups.
 */
export function buildGroupedZip(input: {
  groups: ExportGroup<ExportItem>[];
  format: ExportFormat;
  languageCode: string;
  scopeLabel: string;
}): ExportResult {
  const entries: ZipEntry[] = [];

  for (const group of input.groups) {
    const result = buildExport({
      items: group.rows,
      format: input.format,
      languageCode: input.languageCode,
      scopeLabel: `${input.scopeLabel} — ${group.label}`,
      nameSuffix: group.key ? safeLabel(group.label) : ''
    });
    entries.push({ path: result.filename, data: result.body });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const langPart = input.languageCode ? safeLabel(input.languageCode) : 'source';

  return {
    filename: `mnaqeesh-${langPart}-${stamp}.zip`,
    contentType: 'application/zip',
    body: buildZip(entries)
  };
}

export { buildZip, type ZipEntry };
