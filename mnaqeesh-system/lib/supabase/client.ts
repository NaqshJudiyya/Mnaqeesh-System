import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client.
 *
 * This deliberately uses the PUBLISHABLE key, not the service key: the
 * dashboard runs under the signed-in user's own JWT, and every data
 * access is additionally constrained by the RLS policies in
 * `supabase/migrations/0001_mnaqeesh.sql`.
 *
 * The same session created here is what `/connect` hands to the
 * extension, so the extension receives a genuine Supabase session with
 * a working refresh token.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('إعدادات Supabase غير مكتملة (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).');
  }
  return createBrowserClient(url, key);
}
