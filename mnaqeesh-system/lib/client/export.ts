/**
 * Export — the browser-side replacement of the /api/export route.
 *
 * The builders in lib/export/* are pure and now browser-compatible, so
 * the flow becomes: fetch the filtered rows through RLS → flatten each
 * post into its language version → build the file(s) in memory → hand
 * them to the browser as a download. No server involved.
 */

import { resolvePostContent, type ExportFormat, type PostFilters, type PostRow, type TranslationRow } from '@/lib/types';
import type { Profile } from '@/lib/rbac';
import { listPostsForExport, postIdsTranslatedInto } from '@/lib/client/posts';
import {
  buildExport,
  buildGroupedZip,
  findTranslation,
  groupRows,
  type ExportGroupMode,
  type ExportItem
} from '@/lib/export/exporters';

const FORMATS: ExportFormat[] = ['xlsx', 'json', 'markdown', 'csv', 'wxr'];

export function isExportFormat(value: string): value is ExportFormat {
  return (FORMATS as string[]).includes(value);
}

/** Flattens a post (and optionally its translation) into one export row. */
function toItem(
  post: PostRow,
  translation: TranslationRow | null,
  languageName: string,
  includeSource: boolean
): ExportItem {
  const translatedText = translation?.translated_text ?? '';
  const translatedMarkdown = translation?.body_markdown ?? '';
  const isSource = !translation;
  const content = resolvePostContent(post);

  return {
    postId: post.id,
    postKey: post.post_key,
    userId: post.user_id,
    // The Arabic source is only carried when the export IS the source.
    sourceTitle: '',
    sourceText: includeSource ? content.text : '',
    sourceMarkdown: includeSource ? content.markdown : '',
    title: translation?.title ?? '',
    text: isSource ? content.text : translatedText,
    markdown: isSource ? content.markdown : translatedMarkdown || translatedText,
    languageCode: translation?.language_code ?? '',
    languageName,
    author: post.author,
    date: post.post_date,
    time: post.post_time,
    privacy: post.privacy,
    imageUrls: post.image_urls || [],
    videoUrl: post.video_url,
    postUrl: post.post_url,
    savedAt: post.saved_at,
    translatorName: translation?.translator?.full_name || translation?.translator?.email || ''
  };
}

export type ExportRequest = {
  profile: Profile;
  format: ExportFormat;
  /** 'source' or a language code. */
  scope: string;
  owner?: string;
  group: ExportGroupMode;
  from?: string;
  to?: string;
  languageName: (code: string) => string;
};

export type ExportOutcome = { filename: string; count: number };

/**
 * Builds and downloads the export. Throws with an Arabic message when
 * nothing matches or the chosen language is unknown.
 */
export async function runExport(request: ExportRequest): Promise<ExportOutcome> {
  const { profile, format, scope, group } = request;

  const isLanguage = scope !== 'source';
  const languageName = isLanguage ? request.languageName(scope) : 'العربية';

  const filters: Omit<PostFilters, 'page' | 'pageSize'> = {
    owner: request.owner,
    from: request.from,
    to: request.to,
    sort: 'newest'
  };
  const posts = await listPostsForExport(profile, { ...filters, language: isLanguage ? scope : '' });

  const items: ExportItem[] = [];
  for (const post of posts) {
    if (!isLanguage) {
      items.push(toItem(post, null, languageName, true));
      continue;
    }
    const translation = findTranslation(post, scope);
    if (!translation) continue; // Never mix: a missing translation is skipped.
    items.push(toItem(post, translation, languageName, false));
  }

  if (items.length === 0) {
    throw new Error(
      isLanguage
        ? `لا توجد ترجمات باللغة ${languageName} ضمن النطاق المحدد.`
        : 'لا توجد منشورات مطابقة للتصدير.'
    );
  }

  const scopeLabel = isLanguage ? `ترجمة ${languageName}` : 'النص الأصلي (العربية)';
  const languageCode = isLanguage ? scope : '';

  let result;
  if (group !== 'all') {
    const ownerLabels = new Map<string, string>();
    for (const post of posts) {
      const label = post.owner?.full_name || post.owner?.email || '';
      if (post.user_id && label) ownerLabels.set(post.user_id, label);
    }

    const groups = groupRows(items, group, ownerLabels);
    if (groups.length === 0) {
      throw new Error(
        group === 'account'
          ? 'لا توجد منشورات مطابقة للتصدير.'
          : 'لا توجد منشورات بتاريخ صالح للتقسيم حسب السنة أو الشهر.'
      );
    }

    if (groups.length === 1) {
      result = await buildExport({
        items: groups[0].rows,
        format,
        languageCode,
        scopeLabel: `${scopeLabel} — ${groups[0].label}`,
        nameSuffix: groups[0].key ? groups[0].label : ''
      });
    } else {
      result = await buildGroupedZip({ groups, format, languageCode, scopeLabel });
    }
  } else {
    result = await buildExport({ items, format, languageCode, scopeLabel });
  }

  downloadResult(result);
  return { filename: result.filename, count: items.length };
}

/** Triggers a browser download for a built file. */
export function downloadResult(result: {
  filename: string;
  body: Uint8Array;
  contentType?: string;
}): void {
  const blob = new Blob([result.body as BlobPart], {
    type: result.contentType ?? 'application/octet-stream'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
