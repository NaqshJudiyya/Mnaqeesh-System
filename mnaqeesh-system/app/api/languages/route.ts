import { NextResponse } from 'next/server';
import { logActivity, requireUser } from '@/lib/session';
import { canAddLanguage, isAdmin } from '@/lib/rbac';
import { countTranslationsForLanguage, deleteLanguage, listLanguages, upsertLanguage } from '@/lib/data';
import { languageCode, text } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The shared list of translation languages. */
export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  const languages = await listLanguages();
  return NextResponse.json({ languages }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Registers a new translation language.
 *
 * Languages are introduced gradually — a translator who needs a language
 * that does not exist yet names it here, and it immediately becomes
 * available for every post in the system.
 */
export async function POST(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canAddLanguage(session.profile)) {
    return NextResponse.json({ error: 'لا تملك صلاحية إضافة لغات.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const code = languageCode(body.code);
  if (!code) {
    return NextResponse.json(
      { error: 'رمز اللغة غير صالح. استخدم رمزًا مثل en أو fr أو pt-BR.' },
      { status: 400 }
    );
  }

  const nameAr = text(body.nameAr, 60);
  const nameEn = text(body.nameEn, 60);
  if (!nameAr && !nameEn) {
    return NextResponse.json({ error: 'اكتب اسم اللغة.' }, { status: 400 });
  }

  try {
    const language = await upsertLanguage({
      code,
      nameAr: nameAr || nameEn,
      nameEn: nameEn || nameAr,
      createdBy: session.userId
    });

    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'language.add',
      entity: 'languages',
      entityId: code,
      details: { nameAr: language.name_ar }
    });

    return NextResponse.json({ ok: true, language });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر إضافة اللغة.' },
      { status: 500 }
    );
  }
}

/**
 * Removes a language. Refused while translations still use it, so no
 * translated content is ever silently dropped.
 */
export async function DELETE(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  // Removing a whole language is a system-level act: manager only.
  // Goes through the shared helper so every role decision stays in one file.
  if (!isAdmin(session.profile)) {
    return NextResponse.json({ error: 'حذف اللغات متاح لمدير النظام فقط.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const code = languageCode(url.searchParams.get('code'));
  if (!code) return NextResponse.json({ error: 'رمز اللغة غير صالح.' }, { status: 400 });

  try {
    // Refuse to delete the system's default translation language.
    const languages = await listLanguages();
    const target = languages.find((row) => row.code === code);
    if (!target) {
      return NextResponse.json({ error: 'اللغة غير موجودة.' }, { status: 404 });
    }
    if (target.is_default) {
      return NextResponse.json({ error: 'لا يمكن حذف اللغة الافتراضية للنظام.' }, { status: 409 });
    }

    const used = await countTranslationsForLanguage(code);
    if (used > 0) {
      return NextResponse.json(
        { error: `لا يمكن حذف اللغة: توجد ${used} ترجمة تستخدمها. احذف الترجمات أولًا.` },
        { status: 409 }
      );
    }

    await deleteLanguage(code);
    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'language.delete',
      entity: 'languages',
      entityId: code
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    // The count-then-delete is not atomic: a translation inserted in
    // between makes the foreign key RESTRICT fire. Report that as the same
    // 409 the user would otherwise have seen, rather than a bare 500.
    const message = error instanceof Error ? error.message : '';
    if (/foreign key|still referenced/i.test(message)) {
      return NextResponse.json(
        { error: 'لا يمكن حذف اللغة: أُضيفت ترجمة تستخدمها للتو. احذف الترجمات ثم أعد المحاولة.' },
        { status: 409 }
      );
    }
    console.error('[languages] delete failed:', message);
    return NextResponse.json({ error: 'تعذر حذف اللغة.' }, { status: 500 });
  }
}
