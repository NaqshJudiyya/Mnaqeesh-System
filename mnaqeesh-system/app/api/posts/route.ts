import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { listPosts } from '@/lib/data';
import { readPostFilters } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paged post list for the dashboard.
 *
 * Scope is enforced by RLS plus an explicit filter in `listPosts`:
 * a collector only ever receives their own rows.
 */
export async function GET(request: Request) {
  const session = await requireUser();
  if (!session) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const filters = readPostFilters(url.searchParams);
    const page = await listPosts(session.profile, filters);
    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Log the real cause server-side; the response stays generic so no
    // database or PostgREST internals reach the browser.
    console.error('[posts] list failed:', error);
    return NextResponse.json({ error: 'تعذر تحميل المنشورات.' }, { status: 500 });
  }
}
