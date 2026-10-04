import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client. SERVER ONLY.
 *
 * This key bypasses RLS, so it is used exclusively for the operations
 * that genuinely need to step outside the caller's own rows:
 *   - reading the member list (admin only)
 *   - changing another member's role or status (admin only)
 *   - reading/writing the audit log
 *
 * Every one of those call sites must first pass a check in
 * `lib/rbac.ts`. NEVER import this module from a client component.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('مفتاح خدمة Supabase غير مضبوط (SUPABASE_SERVICE_ROLE_KEY).');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}
