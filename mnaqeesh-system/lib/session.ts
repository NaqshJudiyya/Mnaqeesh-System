/**
 * Server-side session helpers.
 *
 * `requireUser()` is the single gate used by every protected page and
 * route handler. It returns the profile only when the account exists
 * AND the manager has activated it, which is what implements your rule
 * that "بيانات الدخول المدير بيتحكم فيها يدويًا".
 */

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { type Profile, type Role, type Status } from '@/lib/rbac';
import type { ActivityRow } from '@/lib/types';

export type SessionUser = {
  userId: string;
  email: string;
  profile: Profile;
};

/**
 * Reads the profile of the signed-in user.
 *
 * Uses the service client so that a `pending` or `disabled` account can
 * still be recognised (RLS would hide a non-active row from the user's
 * own token, and we need to tell such a user *why* they are blocked).
 */
export async function getProfileByUserId(userId: string): Promise<Profile | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('profiles')
    .select('id,email,full_name,avatar_url,role,status,note,created_at,updated_at')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Profile;
}

/** The raw authenticated Supabase user, or null. */
export async function getAuthUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/**
 * Full session gate. Returns null when:
 *   - nobody is signed in, or
 *   - the account has no profile row, or
 *   - the manager has not activated the account.
 */
export async function requireUser(): Promise<SessionUser | null> {
  const user = await getAuthUser();
  if (!user) return null;

  const profile = await getProfileByUserId(user.id);
  if (!profile || profile.status !== 'active') return null;

  return {
    userId: user.id,
    email: user.email ?? profile.email,
    profile
  };
}

/**
 * Like `requireUser`, but also reports *why* access was refused so the
 * "not authorized" page can explain the situation to the member.
 */
export async function describeAccess(): Promise<
  | { state: 'anonymous' }
  | { state: 'no_profile'; email: string }
  | { state: 'pending'; profile: Profile }
  | { state: 'disabled'; profile: Profile }
  | { state: 'active'; session: SessionUser }
> {
  const user = await getAuthUser();
  if (!user) return { state: 'anonymous' };

  const profile = await getProfileByUserId(user.id);
  if (!profile) return { state: 'no_profile', email: user.email ?? '' };
  if (profile.status === 'pending') return { state: 'pending', profile };
  if (profile.status === 'disabled') return { state: 'disabled', profile };

  return {
    state: 'active',
    session: { userId: user.id, email: user.email ?? profile.email, profile }
  };
}

// ---------------------------------------------------------------------
// Manager-only helpers
// ---------------------------------------------------------------------

export type MemberRow = Profile & { post_count?: number };

/** Lists every member. Admin only — callers must check `canManageMembers`. */
export async function listMembers(): Promise<MemberRow[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('profiles')
    .select('id,email,full_name,avatar_url,role,status,note,created_at,updated_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error('تعذر تحميل الأعضاء: ' + error.message);
  return (data ?? []) as MemberRow[];
}

/**
 * Counts saved posts per member so the manager can see who is actually
 * contributing. Uses a head-count query per member; the member list is
 * small, so this stays cheap.
 */
export async function countPostsByUser(): Promise<Record<string, number>> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('posts')
    .select('user_id')
    .is('deleted_at', null);

  if (error) return {};
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { user_id: string }[]) {
    counts[row.user_id] = (counts[row.user_id] ?? 0) + 1;
  }
  return counts;
}

/** Records an action in the audit log. Never throws. */
export async function logActivity(input: {
  actorId: string | null;
  actorEmail: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const service = createServiceClient();
    await service.from('activity_log').insert({
      actor_id: input.actorId,
      actor_email: input.actorEmail,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? '',
      details: input.details ?? {}
    });
  } catch {
    // Logging must never break the user-facing operation.
  }
}

/** Recent audit entries for the manager's activity panel. */
export async function listActivity(limit = 40) {
  const service = createServiceClient();
  const { data, error } = await service
    .from('activity_log')
    .select('id,actor_email,action,entity,entity_id,details,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as ActivityRow[];
}

/** Guard used by route handlers. */
export type RequireRoleResult =
  | { ok: true; session: SessionUser }
  | { ok: false; response: Response };

export function roleError(message: string, status = 403): Response {
  return Response.json({ error: message }, { status });
}

export function coerceRole(value: unknown): Role | null {
  return typeof value === 'string' && ['admin', 'editor', 'collector', 'translator'].includes(value)
    ? (value as Role)
    : null;
}

export function coerceStatus(value: unknown): Status | null {
  return typeof value === 'string' && ['pending', 'active', 'disabled'].includes(value)
    ? (value as Status)
    : null;
}
