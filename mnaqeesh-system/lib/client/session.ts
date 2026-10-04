/**
 * Client-side session — the static-hosting replacement of lib/session.ts.
 *
 * The browser reads its OWN profile row through RLS
 * (`profiles_select_self` lets every account see its own row, even a
 * pending or disabled one), which is what the auth gate needs to tell a
 * blocked member WHY they are blocked — without any server involved.
 */

import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/lib/rbac';

export type SessionUser = {
  userId: string;
  email: string;
  profile: Profile;
};

export type ClientAccess =
  | { state: 'loading' }
  | { state: 'anonymous' }
  | { state: 'no_profile'; email: string }
  | { state: 'pending'; profile: Profile }
  | { state: 'disabled'; profile: Profile }
  | { state: 'active'; session: SessionUser };

const PROFILE_COLUMNS = 'id,email,full_name,avatar_url,role,status,note,created_at,updated_at';

/** Reads the signed-in member's own profile through RLS. */
export async function describeAccess(): Promise<ClientAccess> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return { state: 'anonymous' };

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', user.id)
    .maybeSingle();

  if (error || !profile) {
    return { state: 'no_profile', email: user.email ?? '' };
  }

  const row = profile as Profile;
  if (row.status === 'pending') return { state: 'pending', profile: row };
  if (row.status === 'disabled') return { state: 'disabled', profile: row };

  return {
    state: 'active',
    session: { userId: user.id, email: user.email ?? row.email, profile: row }
  };
}

/** The current Supabase access token, for calling the admin edge function. */
export async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Waits briefly for a session to appear.
 *
 * After the OAuth redirect the browser client exchanges the PKCE code
 * during initialisation, so the very first getSession() can race it.
 */
export async function waitForSession(attempts = 8): Promise<ReturnType<typeof getSessionInternal>> {
  let last: Awaited<ReturnType<typeof getSessionInternal>> = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await getSessionInternal();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

async function getSessionInternal() {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/**
 * Writes an audit entry through the `log_activity` RPC (migration 0007).
 * Never throws: logging must not break the user-facing action.
 */
export async function logActivity(input: {
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createClient();
    await supabase.rpc('log_activity', {
      p_action: input.action,
      p_entity: input.entity,
      p_entity_id: input.entityId ?? '',
      p_details: input.details ?? {}
    });
  } catch {
    // Ignore — the action itself already succeeded or failed on its own.
  }
}
