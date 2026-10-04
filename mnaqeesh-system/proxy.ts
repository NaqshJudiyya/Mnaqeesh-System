import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase session cookie on every request.
 *
 * Without this, a signed-in user's access token would silently expire
 * and the server components would start seeing an anonymous user.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`, and the
 * handler must be the default export.
 */
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Without configuration we cannot refresh; let the page itself show
  // the missing-configuration message instead of crashing here.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });

  try {
    // Touching getUser() is what triggers the refresh.
    await supabase.auth.getUser();
  } catch {
    // A refresh failure must not break the request; the dashboard will
    // simply render its signed-out state.
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets, so page loads and route
     * handlers always see a fresh session.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'
  ]
};
