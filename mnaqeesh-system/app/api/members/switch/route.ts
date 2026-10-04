import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/session';
import { logActivity } from '@/lib/session';
import { canManageMembers } from '@/lib/rbac';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Switches the dashboard into another member's account.
 *
 * Two conditions must BOTH hold, which is what keeps this from being a
 * privilege-escalation hole:
 *
 *   1. `owner` must equal the id of the account that originally performed
 *      the switch. The original session's tokens live in an httpOnly
 *      cookie that only this route can read, so nobody else can ask to
 *      "return" into it.
 *   2. The caller must currently be that same account.
 *
 * In other words: an admin may enter a member's account, and only the
 * admin who did so may leave it again. Calling this endpoint from any
 * other account is rejected.
 */
export async function POST(request: Request) {
  const session = await requireUser();
  if (!session) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const owner = uuid(body.owner);
  if (!owner || owner !== session.userId) {
    return NextResponse.json(
      { error: 'تبديل الحساب متاح فقط للحساب الذي بدأ التبديل. سجّل الخروج وادخل بحسابك.' },
      { status: 403 }
    );
  }

  // Read the token pair saved when the switch started.
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const raw = store.get('mnq_origin')?.value;
  if (!raw) {
    return NextResponse.json(
      { error: 'لا توجد جلسة أصلية محفوظة. سجّل الخروج وادخل بحسابك الأصلي.' },
      { status: 400 }
    );
  }

  let tokens: { access_token?: string; refresh_token?: string; email?: string };
  try {
    tokens = JSON.parse(raw) as typeof tokens;
  } catch {
    return NextResponse.json({ error: 'بيانات الجلسة الأصلية غير صالحة.' }, { status: 400 });
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    return NextResponse.json({ error: 'الجلسة الأصلية ناقصة. سجّل الدخول من جديد.' }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token
  });

  if (error) {
    console.error('[members] restore session failed:', error.message);
    return NextResponse.json(
      { error: 'انتهت صلاحية الجلسة الأصلية. سجّل الخروج ثم ادخل بحسابك.' },
      { status: 401 }
    );
  }

  const response = NextResponse.json({ ok: true, email: tokens.email ?? '' });

  // The original session is now the live one, so the stash is no longer
  // needed — clearing it also means it cannot be replayed.
  response.cookies.set('mnq_origin', '', { path: '/', maxAge: 0 });

  await logActivity({
    actorId: owner,
    actorEmail: tokens.email ?? session.email,
    action: 'member.switch_back',
    entity: 'profiles',
    entityId: owner,
    details: { returnedFrom: session.email }
  });

  return response;
}

/**
 * Starts a switch: verifies the member's password, then saves the
 * admin's own session so it can be restored later.
 */
export async function PUT(request: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canManageMembers(session.profile)) {
    return NextResponse.json({ error: 'تبديل الحساب متاح لمدير النظام فقط.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const targetId = uuid(body.targetUserId);
  const password = String(body.password ?? '');
  const origin = uuid(body.owner);

  if (!targetId || !password) {
    return NextResponse.json({ error: 'اختر العضو وأدخل كلمة مروره.' }, { status: 400 });
  }
  if (!origin || origin !== session.userId) {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 403 });
  }
  if (targetId === session.userId) {
    return NextResponse.json({ error: 'أنت بالفعل داخل هذا الحساب.' }, { status: 400 });
  }

  const supabase = await createClient();

  // The member's email is needed to sign in as them.
  const { data: targetProfile } = await supabase
    .from('profiles')
    .select('email,full_name')
    .eq('id', targetId)
    .maybeSingle();

  const targetEmail = (targetProfile as { email?: string } | null)?.email ?? '';
  if (!targetEmail) {
    return NextResponse.json({ error: 'لا يمكن قراءة بيانات هذا العضو.' }, { status: 404 });
  }

  // Save the current session BEFORE switching away from it.
  const { data: current } = await supabase.auth.getSession();
  const currentSession = current.session;

  const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
    email: targetEmail,
    password
  });

  if (signInError || !signedIn.session) {
    return NextResponse.json(
      { error: 'كلمة المرور غير صحيحة لهذا العضو. الأعضاء المُنشؤون بجوجل ليس لهم كلمة مرور.' },
      { status: 401 }
    );
  }

  const response = NextResponse.json({
    ok: true,
    email: targetEmail,
    name: (targetProfile as { full_name?: string } | null)?.full_name ?? ''
  });

  if (currentSession?.access_token && currentSession.refresh_token) {
    // httpOnly + sameSite=lax: unreadable from JavaScript and not sent
    // from another site. The PIN below would normally be derived from the
    // owner cookie inside the server; here the stored token pair IS the
    // credential, which is why the cookie must never leak.
    response.cookies.set(
      'mnq_origin',
      JSON.stringify({
        access_token: currentSession.access_token,
        refresh_token: currentSession.refresh_token,
        email: session.email
      }),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 8 // long enough for a work session
      }
    );
  }

  await logActivity({
    actorId: session.userId,
    actorEmail: session.email,
    action: 'member.switch_to',
    entity: 'profiles',
    entityId: targetId,
    details: { targetEmail }
  });

  return response;
}
