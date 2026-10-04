import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { canExport, type Profile } from '@/lib/rbac';
import { listPostsForExport, listLanguages } from '@/lib/data';
import { buildExport, buildGroupedZip, findTranslation, groupRows, type ExportGroupMode, type ExportItem, type ExportResult } from '@/lib/export/exporters';
import { readPostFilters } from '@/lib/validation';
import type { ExportFormat, ExportScope, PostRow, TranslationRow } from '@/lib/types';
import { resolvePostContent } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS: ExportFormat[] = ['xlsx', 'json', 'markdown', 'csv', 'wxr'];
const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  wxr: 'application/xml; charset=utf-8'
};

/**
 * Export endpoint.
 *
 * The language is always explicit:
 *   scope=source           -> export the original Arabic content
 *   scope=<code>&language=<code> -> export ONLY that language's version
 *
 * A post that has no translation in the chosen language is skipped, so a
 * file never silently mixes languages.
 */
export async function GET(request: Request) {
  const session = await requireUser();
  if (!session) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });
  }
  if (!canExport(session.profile)) {
    return NextResponse.json({ error: 'حسابك غير مفعّل للتصدير.' }, { status: 403 });
  }

  // Everything past this point can fail on a database error, so it is
  // wrapped: without this, a PostgREST failure would escape the handler
  // and Next would return an HTML 500 page instead of the JSON error the
  // dashboard knows how to display.
  try {
    return await performExport(request, session.profile);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر إنشاء ملف التصدير.' },
      { status: 500 }
    );
  }
}

async function performExport(request: Request, profile: Profile): Promise<Response> {
  const url = new URL(request.url);
  const formatParam = (url.searchParams.get('format') ?? 'xlsx').toLowerCase();
  const format = (FORMATS as string[]).includes(formatParam) ? (formatParam as ExportFormat) : 'xlsx';

  const scopeParam = url.searchParams.get('scope') ?? 'source';
  const languageParam = url.searchParams.get('language') ?? '';

  let scope: ExportScope = { kind: 'source' };
  if (scopeParam && scopeParam !== 'source') {
    scope = { kind: 'language', code: scopeParam };
  } else if (languageParam) {
    scope = { kind: 'language', code: languageParam };
  }

  const filters = readPostFilters(url.searchParams);
  const posts = await listPostsForExport(profile, filters);

  const languages = await listLanguages();
  const language = scope.kind === 'language' ? languages.find((row) => row.code === scope.code) ?? null : null;
  const languageName = scope.kind === 'source' ? 'العربية' : language?.name_ar || scope.code;

  if (scope.kind === 'language' && !language) {
    return NextResponse.json({ error: 'اللغة المطلوبة غير معروفة في النظام.' }, { status: 400 });
  }

  const items: ExportItem[] = [];

  for (const post of posts) {
    if (scope.kind === 'source') {
      items.push(toItem(post, null, languageName, true));
      continue;
    }
    const translation = findTranslation(post, scope.code);
    if (!translation) continue; // Never mix: a missing translation is skipped.
    // `false` = do not carry the Arabic source into a translation file.
    items.push(toItem(post, translation, languageName, false));
  }

  const scopeLabel = scope.kind === 'source' ? 'النص الأصلي (العربية)' : `ترجمة ${languageName}`;

  if (items.length === 0) {
    return NextResponse.json(
      {
        error:
          scope.kind === 'source'
            ? 'لا توجد منشورات مطابقة للتصدير.'
            : `لا توجد ترجمات باللغة ${languageName} ضمن النطاق المحدد.`
      },
      { status: 404 }
    );
  }

  // ---- split the export into files ----------------------------------
  const groupParam = (url.searchParams.get('group') ?? 'all').toLowerCase();
  const groupMode: ExportGroupMode = (['all', 'year', 'month', 'account'] as const).includes(
    groupParam as ExportGroupMode
  )
    ? (groupParam as ExportGroupMode)
    : 'all';

  const languageCode = scope.kind === 'language' ? scope.code : '';

  if (groupMode !== 'all') {
    // Account grouping needs display names; posts carry the owner for the
    // manager, and fall back to the id otherwise.
    const ownerLabels = new Map<string, string>();
    for (const post of posts) {
      const label = post.owner?.full_name || post.owner?.email || '';
      if (post.user_id && label) ownerLabels.set(post.user_id, label);
    }

    const groups = groupRows(items, groupMode, ownerLabels);

    if (groups.length === 0) {
      return NextResponse.json(
        {
          error:
            groupMode === 'account'
              ? 'لا توجد منشورات مطابقة للتصدير.'
              : 'لا توجد منشورات بتاريخ صالح للتقسيم حسب السنة أو الشهر. تأكد من وجود تاريخ للمنشورات.'
        },
        { status: 404 }
      );
    }

    // A single group needs no archive — hand back the file itself.
    if (groups.length === 1) {
      const only = buildExport({
        items: groups[0].rows,
        format,
        languageCode,
        scopeLabel: `${scopeLabel} — ${groups[0].label}`,
        nameSuffix: groups[0].key ? groups[0].label : ''
      });
      return fileResponse(only);
    }

    const archive = buildGroupedZip({ groups, format, languageCode, scopeLabel });
    return fileResponse(archive);
  }

  const result = buildExport({ items, format, languageCode, scopeLabel });

  return fileResponse(result, MIME_BY_FORMAT[format]);
}

/**
 * Streams a generated file back to the browser.
 *
 * The Content-Type comes from the actual builder rather than the requested
 * format, because a split export returns a ZIP even when the requested
 * format was XLSX.
 */
function fileResponse(result: ExportResult, explicitType?: string): Response {
  return new NextResponse(new Uint8Array(result.body), {
    status: 200,
    headers: {
      'Content-Type': explicitType ?? result.contentType,
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store'
    }
  });
}

function toItem(
  post: PostRow,
  translation: TranslationRow | null,
  languageName: string,
  includeSource: boolean
): ExportItem {
  const translatedText = translation?.translated_text ?? '';
  const translatedMarkdown = translation?.body_markdown ?? '';
  const isSource = !translation;

  // An edit made inside مناقيش always wins over what the extension
  // scraped, so the exported file reflects the current content.
  const content = resolvePostContent(post);

  return {
    postId: post.id,
    postKey: post.post_key,
    userId: post.user_id,
    // The Arabic source is only carried when the export IS the source.
    // Embedding it in a per-language file would mean a "only language X"
    // file still contained the original Arabic text.
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
