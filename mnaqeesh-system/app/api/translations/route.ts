import { NextResponse } from 'next/server';
import { logActivity, requireUser } from '@/lib/session';
import { canTranslate } from '@/lib/rbac';
import { getPost, upsertLanguage, upsertTranslation } from '@/lib/data';
import { bool, languageCode, longText, text, uuid } from '@/lib/validation';

export const runtime = 'nodejs';

/**
 * Create or update the translation of one post in one language.
 *
 * This is the "أضف ترجمة" action. When the language does not yet exist in
 * the system it is registered on the fly, so translators can introduce
 * languages incrementally — and any later translator can add a second,
 * third, … language to the same post as separate rows.
 */
export async function POST(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canTranslate(session.profile)) {
    return NextResponse.json({ error: 'لا تملك صلاحية إضافة الترجمات.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const postId = uuid(body.postId);
  if (!postId) return NextResponse.json({ error: 'معرّف المنشور غير صالح.' }, { status: 400 });

  const code = languageCode(body.languageCode);
  if (!code) return NextResponse.json({ error: 'رمز اللغة غير صالح (مثال: en أو fr).' }, { status: 400 });

  const translatedText = longText(body.translatedText, 100000);
  const title = text(body.title, 300);
  if (!translatedText.trim() && !title.trim()) {
    return NextResponse.json({ error: 'اكتب نص الترجمة أو عنوانها قبل الحفظ.' }, { status: 400 });
  }

  // RLS already scopes visibility; this also confirms the post exists.
  const post = await getPost(session.profile, postId);
  if (!post) return NextResponse.json({ error: 'المنشور غير موجود أو لا تملك صلاحية الوصول إليه.' }, { status: 404 });

  try {
    // Register the language if a translator has just invented it.
    await upsertLanguage({
      code,
      nameAr: text(body.languageNameAr, 60) || code,
      nameEn: text(body.languageNameEn, 60) || code,
      createdBy: session.userId
    });

    const translation = await upsertTranslation({
      postId,
      languageCode: code,
      title,
      translatedText,
      bodyMarkdown: longText(body.bodyMarkdown, 100000),
      translatorId: session.userId,
      isComplete: bool(body.isComplete)
    });

    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'translation.save',
      entity: 'translations',
      entityId: translation.id,
      details: { postId, language: code }
    });

    return NextResponse.json({ ok: true, translation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر حفظ الترجمة.' },
      { status: 500 }
    );
  }
}
