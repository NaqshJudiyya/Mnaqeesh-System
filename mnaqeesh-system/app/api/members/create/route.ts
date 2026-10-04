import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logActivity, requireUser } from '@/lib/session';
import { canManageMembers, ROLE_LABELS, type Role } from '@/lib/rbac';
import { optionalRole, optionalStatus, text } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Builds the unique "shadow" address for a member created by username only. */
function shadowEmail(username: string): string {
  return `${username.toLowerCase().replace(/[^a-z0-9._-]/g, '')}@members.mnaqeesh.local`;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/**
 * Creates a member by hand.
 *
 * The manager does not have to wait for someone to sign in with Google
 * first: they can create the account here, hand over the username and
 * password, and the member signs in with those. Members created this way
 * are marked `active` immediately unless the manager says otherwise.
 *
 * Both paths therefore coexist:
 *   - Google sign-in  -> profile auto-created as `pending`, manager approves
 *   - Manual creation -> profile created by the manager, ready to use
 */
export async function POST(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canManageMembers(session.profile)) {
    return NextResponse.json({ error: 'إضافة الأعضاء متاحة لمدير النظام فقط.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const username = text(body.username, 32);
  const password = String(body.password ?? '');
  const fullName = text(body.fullName, 120);
  const emailInput = text(body.email, 200);
  const role = optionalRole(body.role) ?? ('collector' as Role);
  const status = optionalStatus(body.status) ?? 'active';

  // Validate: either a real email, or a valid username we turn into one.
  if (!emailInput && !USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: 'اسم المستخدم يجب أن يكون 3–32 حرفًا إنجليزيًا (حروف وأرقام ونقطة أو شرطة).' },
      { status: 400 }
    );
  }

  const email = emailInput || shadowEmail(username);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'البريد الإلكتروني غير صالح.' }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' }, { status: 400 });
  }

  const service = createServiceClient();

  // Reject a duplicate before asking Supabase, so the message is clear.
  const { data: existing } = await service
    .from('profiles')
    .select('id,email')
    .ilike('email', email)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'يوجد عضو مسجّل بهذا البريد بالفعل.' }, { status: 409 });
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    // A manager-created account is usable immediately.
    email_confirm: true,
    user_metadata: {
      full_name: fullName || username || email,
      created_by_manager: true,
      username: username || ''
    }
  });

  if (createError || !created?.user) {
    const message = createError?.message ?? '';
    if (/already registered|already exists/i.test(message)) {
      return NextResponse.json({ error: 'هذا البريد مُستخدم بالفعل في Supabase Auth.' }, { status: 409 });
    }
    console.error('[members] createUser failed:', message);
    return NextResponse.json({ error: 'تعذر إنشاء العضو: ' + message }, { status: 500 });
  }

  const userId = created.user.id;

  // The auth trigger creates the profile as pending/collector; set the
  // manager's real choices now.
  const { error: profileError } = await service
    .from('profiles')
    .update({
      role,
      status,
      full_name: fullName || username || email,
      note: text(body.note, 500)
    })
    .eq('id', userId);

  if (profileError) {
    console.error('[members] profile update failed:', profileError.message);
    return NextResponse.json(
      { error: 'أُنشئ الحساب لكن تعذّر ضبط الدور. عدّل العضو من القائمة.', userId },
      { status: 207 }
    );
  }

  await logActivity({
    actorId: session.userId,
    actorEmail: session.email,
    action: 'member.create',
    entity: 'profiles',
    entityId: userId,
    details: { email, role, roleLabel: ROLE_LABELS[role], status, createdManually: true }
  });

  return NextResponse.json({
    ok: true,
    member: { id: userId, email, full_name: fullName || username || email, role, status },
    login: emailInput
      ? { mode: 'email', email }
      : { mode: 'username', username, email }
  });
}
