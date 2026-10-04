import { NextResponse } from 'next/server';
import { logActivity, requireUser } from '@/lib/session';
import { canEditPost } from '@/lib/rbac';
import { getPost, updatePostContent } from '@/lib/data';
import { longText, postStatus, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * In-app Markdown editor.
 *
 * This is the مناقيش counterpart of the extension's own Markdown editor.
 * Permissions mirror the rule you specified:
 *
 *   collector  -> only posts they saved themselves
 *   editor     -> any post
 *   admin      -> any post
 *   translator -> not a content editor (they own translations)
 *
 * `canEditPost` in lib/rbac.ts is the single place that decides, and the
 * same decision also runs at the database level via RLS.
 */
export async function PUT(request: Request, { params }: Params) {
  const session = await requireUser();
  if (!session) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });
  }

  const { id } = await params;
  const postId = uuid(id);
  if (!postId) {
    return NextResponse.json({ error: 'معرّف المنشور غير صالح.' }, { status: 400 });
  }

  const post = await getPost(session.profile, postId);
  if (!post) {
    return NextResponse.json({ error: 'المنشور غير موجود أو لا تملك صلاحية الوصول إليه.' }, { status: 404 });
  }

  if (!canEditPost(session.profile, post)) {
    return NextResponse.json(
      { error: 'لا تملك صلاحية تعديل هذا المنشور. يمكنك تعديل المنشورات التي حفظتها بنفسك فقط.' },
      { status: 403 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const markdown = longText(body.markdown, 200000);
  const text = longText(body.text, 200000);

  // The manual workflow state travels with the content edit, because the
  // same people are allowed to set it: the manager, and the member who
  // saved the post.
  const manualStatus = postStatus(body.status);

  try {
    await updatePostContent(postId, {
      markdown,
      text,
      editorId: session.userId,
      status: manualStatus ?? undefined
    });

    const cleared = markdown.trim().length === 0 && text.trim().length === 0;

    await logActivity({
      actorId: session.userId,
      actorEmail: session.email,
      action: cleared ? 'post.content.reset' : 'post.content.edit',
      entity: 'posts',
      entityId: postId,
      details: {
        postKey: post.post_key,
        markdownLength: markdown.trim().length,
        // Kept short on purpose: the audit log should not store whole posts.
        preview: markdown.trim().slice(0, 120)
      }
    });

    return NextResponse.json({ ok: true, cleared });
  } catch (error) {
    console.error('[posts] content edit failed:', error);
    return NextResponse.json({ error: 'تعذر حفظ التعديل.' }, { status: 500 });
  }
}
