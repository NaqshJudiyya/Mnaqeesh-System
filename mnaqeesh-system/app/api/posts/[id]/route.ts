import { NextResponse } from 'next/server';
import { requireUser, logActivity } from '@/lib/session';
import { canDeletePost, canEditPost } from '@/lib/rbac';
import { getPost, softDeletePost, updatePostByEditor } from '@/lib/data';
import { longText, postStatus, text, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** A single post with its translations. */
export async function GET(_request: Request, { params }: Params) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  const { id } = await params;
  const postId = uuid(id);
  if (!postId) return NextResponse.json({ error: 'معرّف المنشور غير صالح.' }, { status: 400 });

  const post = await getPost(session.profile, postId);
  if (!post) return NextResponse.json({ error: 'المنشور غير موجود أو لا تملك صلاحية عرضه.' }, { status: 404 });

  return NextResponse.json({ post }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Dashboard edits: status and internal note.
 *
 * A collector may only do this on posts they saved themselves; an editor
 * or the manager may do it on any post.
 */
export async function PATCH(request: Request, { params }: Params) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  const { id } = await params;
  const postId = uuid(id);
  if (!postId) return NextResponse.json({ error: 'معرّف المنشور غير صالح.' }, { status: 400 });

  const post = await getPost(session.profile, postId);
  if (!post) return NextResponse.json({ error: 'المنشور غير موجود.' }, { status: 404 });

  if (!canEditPost(session.profile, post)) {
    return NextResponse.json({ error: 'لا تملك صلاحية تعديل هذا المنشور.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const patch: { status?: string; editor_note?: string } = {};

  if (body.status !== undefined) {
    const status = postStatus(body.status);
    if (!status) return NextResponse.json({ error: 'حالة المنشور غير صالحة.' }, { status: 400 });
    patch.status = status;
  }

  if (body.editor_note !== undefined) {
    patch.editor_note = longText(body.editor_note, 5000);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول للتحديث.' }, { status: 400 });
  }

  try {
    await updatePostByEditor(postId, patch);
    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'post.update',
      entity: 'posts',
      entityId: postId,
      details: patch as Record<string, unknown>
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر تحديث المنشور.' },
      { status: 500 }
    );
  }
}

/** Soft-delete. Only the owner, an editor, or the manager. */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  const { id } = await params;
  const postId = uuid(id);
  if (!postId) return NextResponse.json({ error: 'معرّف المنشور غير صالح.' }, { status: 400 });

  const post = await getPost(session.profile, postId);
  if (!post) return NextResponse.json({ error: 'المنشور غير موجود.' }, { status: 404 });

  if (!canDeletePost(session.profile, post)) {
    return NextResponse.json({ error: 'لا تملك صلاحية حذف هذا المنشور.' }, { status: 403 });
  }

  try {
    await softDeletePost(postId);
    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: 'post.delete',
      entity: 'posts',
      entityId: postId,
      details: { author: text(post.author, 200) }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر حذف المنشور.' },
      { status: 500 }
    );
  }
}
