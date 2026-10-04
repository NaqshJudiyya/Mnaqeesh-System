import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Google OAuth callback.
 *
 * `@supabase/ssr` uses the PKCE flow, so the `code` query parameter is
 * exchanged for a real session here. Those session cookies are what the
 * dashboard reads, and they are also what `/connect` forwards to the
 * extension.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';
  const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (oauthError) {
    return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent(oauthError), url.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL('/login?error=' + encodeURIComponent('تعذر إكمال تسجيل الدخول: ' + error.message), url.origin)
    );
  }

  // Only same-origin paths. `//evil.com` also "starts with /" but resolves
  // as protocol-relative, so it must be rejected explicitly — otherwise a
  // link like /login?next=//evil.com hands the user to an attacker right
  // after a genuine Google login. Backslashes are rejected too, because
  // some browsers normalise `/\evil.com` the same way.
  const destination = /^\/(?![/\\])/.test(next) ? next : '/';
  return NextResponse.redirect(new URL(destination, url.origin));
}
