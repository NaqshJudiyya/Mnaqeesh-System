import { NextResponse } from 'next/server';
import { logActivity, requireUser } from '@/lib/session';
import { canManageAllContent, canTranslate, isAdmin } from '@/lib/rbac';
import { deleteTranslation, getTranslationForDelete } from '@/lib/data';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';

/**
 * Removes one translation.
 *
 * Translators may delete their own work, but not somebody else's finished
 * translation: losing a completed translation is not recoverable from the
 * interface, so an editor or the manager has to do it deliberately.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canTranslate(session.profile)) {
    return NextResponse.json({ error: 'لا تملك صلاحية حذف الترجمات.' }, { status: 403 });
  }

  const { id } = await params;
  const translationId = uuid(id);
  if (!translationId) return NextResponse.json({ error: 'معرّف الترجمة غير صالح.' }, { status: 400 });

  try {
    const translation = await getTranslationForDelete(translationId);
    if (!translation) {
      return NextResponse.json({ error: 'الترجمة غير موجودة.' }, { status: 404 });
    }

    // A translator may only remove a translation they wrote themselves,
    // and never one that has been marked complete.
    const isOwnDraft =
      translation.translator_id === session.userId && !translation.is_complete;
    const mayOverride = canManageAllContent(session.profile) || isAdmin(session.profile);

    if (!isOwnDraft && !mayOverride) {
      return NextResponse.json(
        {
          error: translation.is_complete
            ? 'هذه الترجمة مكتملة، ولا يمكن حذفها إلا من محرر أو مدير النظام.'
            : 'لا يمكنك حذف ترجمة كتبها مترجم آخر.'
        },
        { status: 403 }
      );
    }

    await deleteTranslation(translationId);
    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'translation.delete',
      entity: 'translations',
      entityId: translationId,
      details: { language: translation.language_code, wasComplete: translation.is_complete }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[translations] delete failed:', error);
    return NextResponse.json({ error: 'تعذر حذف الترجمة.' }, { status: 500 });
  }
}
