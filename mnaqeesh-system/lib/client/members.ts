/**
 * Member management + audit log — browser side.
 *
 * Reads (member list, post counts, activity log) go straight through the
 * browser client: RLS lets an ADMIN see all profiles and the audit log,
 * and hides both from every other role.
 *
 * The two operations that need the service-role key (creating a member
 * with auth.admin.createUser, and setting a password with
 * auth.admin.updateUserById) call the `admin-members` Supabase Edge
 * Function, carrying the caller's own access token. Role/status updates
 * go through the profiles UPDATE grant guarded by the admin-only RLS
 * policy and the last-admin/self-demotion triggers (migration 0007).
 */

import { createClient } from '@/lib/supabase/client';
import { canManageMembers, type Profile, type Role, type Status } from '@/lib/rbac';
import { getAccessToken, logActivity } from '@/lib/client/session';

export type MemberRow = Profile & { post_count?: number };

const PROFILE_COLUMNS = 'id,email,full_name,avatar_url,role,status,note,created_at,updated_at';

/** Lists every member. Admin only — callers must check `canManageMembers`. */
export async function listMembers(): Promise<MemberRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw new Error('تعذر تحميل الأعضاء: ' + error.message);
  return (data ?? []) as MemberRow[];
}

/** Counts saved posts per member so the manager sees who contributes. */
export async function countPostsByUser(): Promise<Record<string, number>> {
  const supabase = createClient();
  const { data, error } = await supabase.from('posts').select('user_id').is('deleted_at', null);
  if (error) return {};
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { user_id: string }[]) {
    counts[row.user_id] = (counts[row.user_id] ?? 0) + 1;
  }
  return counts;
}

/**
 * Activates/deactivates a member or changes their role.
 *
 * The two invariants the route used to enforce — "can't demote or
 * disable yourself", "never remove the last active admin" — are now ALSO
 * database triggers (migration 0007), so a rogue client cannot bypass
 * them. Here they are checked first only to give a friendly error
 * message instead of a raw RLS failure.
 */
export async function updateMember(
  viewer: Profile,
  memberId: string,
  patch: { role?: Role; status?: Status; note?: string }
): Promise<MemberRow> {
  if (!canManageMembers(viewer)) {
    throw new Error('إدارة الأعضاء متاحة لمدير النظام فقط.');
  }
  if (memberId === viewer.id) {
    if (patch.status === 'disabled') throw new Error('لا يمكنك تعطيل حسابك بنفسك.');
    if (patch.role && patch.role !== 'admin') throw new Error('لا يمكنك خفض دورك من داخل هذا الحساب.');
  }

  const supabase = createClient();
  const { data: target, error: readError } = await supabase
    .from('profiles')
    .select('id,email,role,status')
    .eq('id', memberId)
    .maybeSingle();
  if (readError || !target) throw new Error('العضو غير موجود.');

  const nextRole = patch.role ?? target.role;
  const nextStatus = patch.status ?? target.status;
  const losingAdmin =
    target.role === 'admin' && target.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active');

  if (losingAdmin) {
    const { count } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'active');
    if ((count ?? 0) <= 1) throw new Error('لا يمكن إزالة آخر مدير نشط في النظام.');
  }

  const { data: updated, error } = await supabase
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', memberId)
    .select(PROFILE_COLUMNS)
    .single();

  if (error) {
    throw new Error(
      /row-level security|permission denied/i.test(error.message)
        ? 'لا تملك صلاحية تحديث هذا العضو.'
        : 'تعذر تحديث العضو: ' + error.message
    );
  }

  await logActivity({
    action: 'member.update',
    entity: 'profiles',
    entityId: memberId,
    details: { target: target.email, ...patch }
  });

  return updated as MemberRow;
}

// ---------------------------------------------------------------------
// Privileged operations via the admin-members edge function
// ---------------------------------------------------------------------

async function callAdminFunction(body: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  if (!token) throw new Error('انتهت صلاحية الجلسة. سجّل الدخول من جديد.');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('إعدادات Supabase غير مكتملة.');

  const response = await fetch(`${supabaseUrl}/functions/v1/admin-members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || 'تعذر تنفيذ العملية.');
  }
  return payload;
}

export type CreatedMember = {
  ok: true;
  member: { id: string; email: string; full_name: string; role: Role; status: Status };
  login: { mode: 'email'; email: string } | { mode: 'username'; username: string; email: string };
};

/** Creates a member by hand through the admin-members edge function. */
export async function createMember(input: {
  username: string;
  email: string;
  fullName: string;
  password: string;
  role: Role;
  status: Status;
  note?: string;
}): Promise<CreatedMember> {
  const payload = (await callAdminFunction({
    action: 'create',
    ...input
  })) as CreatedMember;

  await logActivity({
    action: 'member.create',
    entity: 'profiles',
    entityId: payload.member.id,
    details: { email: payload.member.email, role: payload.member.role, createdManually: true }
  });

  return payload;
}

/** Assigns a member a password through the admin-members edge function. */
export async function setMemberPassword(memberId: string, password: string): Promise<void> {
  await callAdminFunction({ action: 'set_password', memberId, password });
  await logActivity({ action: 'member.set_password', entity: 'profiles', entityId: memberId, details: {} });
}

// ---------------------------------------------------------------------
// Audit log (manager only, read straight through RLS)
// ---------------------------------------------------------------------

export type ClientActivityRow = {
  id: number;
  actor_email: string;
  action: string;
  entity: string;
  entity_id: string;
  details: Record<string, unknown>;
  created_at: string;
};

export async function listActivity(limit = 60): Promise<ClientActivityRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('activity_log')
    .select('id,actor_email,action,entity,entity_id,details,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as ClientActivityRow[];
}

// ---------------------------------------------------------------------
// Switch account (impersonation)
//
// The old server kept the admin's session in an httpOnly cookie; a
// static site has no server, so the stash lives in sessionStorage — the
// admin's own token, in their own browser tab, cleared on use. Weaker
// than httpOnly against XSS, which is the documented trade-off of static
// hosting; the switch itself still requires the TARGET member's password.
// ---------------------------------------------------------------------

const ORIGIN_STASH_KEY = 'mnq_origin';

export type StashedSession = { access_token: string; refresh_token: string; email: string };

export function readStashedOrigin(): StashedSession | null {
  try {
    const raw = sessionStorage.getItem(ORIGIN_STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StashedSession;
    return parsed.access_token && parsed.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Enters a member's account after verifying their password.
 * The admin's own session is stashed first so they can switch back.
 */
export async function switchToMember(targetEmail: string, password: string): Promise<void> {
  const supabase = createClient();

  const { data: current } = await supabase.auth.getSession();
  const currentSession = current.session;
  if (!currentSession?.access_token || !currentSession.refresh_token) {
    throw new Error('تعذر حفظ جلستك الحالية. سجّل الدخول من جديد.');
  }

  const { data: signedIn, error } = await supabase.auth.signInWithPassword({
    email: targetEmail,
    password
  });
  if (error || !signedIn.session) {
    throw new Error('كلمة المرور غير صحيحة لهذا العضو. الأعضاء المُنشؤون بجوجل ليس لهم كلمة مرور.');
  }

  try {
    sessionStorage.setItem(
      ORIGIN_STASH_KEY,
      JSON.stringify({
        access_token: currentSession.access_token,
        refresh_token: currentSession.refresh_token,
        email: currentSession.user.email ?? ''
      })
    );
  } catch {
    // Private-mode quotas can fail; the switch still worked, only the
    // "switch back without password" convenience is lost.
  }
}

/** Returns into the stashed admin session and clears the stash. */
export async function switchBackToOrigin(): Promise<void> {
  const stash = readStashedOrigin();
  if (!stash) throw new Error('لا توجد جلسة أصلية محفوظة. سجّل الخروج وادخل بحسابك الأصلي.');

  const supabase = createClient();
  const { error } = await supabase.auth.setSession({
    access_token: stash.access_token,
    refresh_token: stash.refresh_token
  });
  if (error) {
    sessionStorage.removeItem(ORIGIN_STASH_KEY);
    throw new Error('انتهت صلاحية الجلسة الأصلية. سجّل الخروج ثم ادخل بحسابك.');
  }

  sessionStorage.removeItem(ORIGIN_STASH_KEY);
}
