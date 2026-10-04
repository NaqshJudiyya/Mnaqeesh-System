import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { isUsableAccount } from '@/lib/rbac';
import {
  ALLOWED_MEDIA_CONTENT,
  MAX_MEDIA_BYTES,
  isAllowedMediaUrl,
  safeMediaFilename,
  upstreamErrorMessage
} from '@/lib/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Media download proxy.
 *
 * WHY A PROXY: Facebook's CDN sends no CORS headers, so the browser cannot
 * fetch a signed CDN URL directly and an `<a download>` cannot force a save
 * cross-origin. Fetching server-side and streaming the bytes back solves
 * both, and lets us set `Content-Disposition: attachment`.
 *
 * NOTE ON QUALITY: this relays the URL stored when the post was saved —
 * the highest-quality source the extension found at that moment (the
 * `srcset` high-water mark, or the `<video>` source). Facebook does not
 * re-encode an older asset on request, so there is no higher variant to
 * ask for later. Signed URLs do expire; when they do, the route reports it
 * clearly instead of saving an error page.
 *
 * The URL is attacker-influenced (it comes from scraped pages), so the
 * guards live in `lib/media.ts` and are unit-tested separately.
 */
export async function GET(request: Request) {
  const session = await requireUser();
  if (!session) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });
  }
  if (!isUsableAccount(session.profile)) {
    return NextResponse.json({ error: 'حسابك غير مفعّل.' }, { status: 403 });
  }

  const searchParams = new URL(request.url).searchParams;
  const raw = searchParams.get('url') ?? '';
  const wantsDownload = searchParams.get('dl') === '1';
  const nameHint = searchParams.get('name') ?? '';

  if (!isAllowedMediaUrl(raw)) {
    return NextResponse.json({ error: 'رابط الوسيط غير صالح أو غير مسموح.' }, { status: 400 });
  }

  const target = new URL(raw);

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      redirect: 'follow',
      headers: {
        // Some CDNs reject a request that has no user agent.
        'User-Agent': 'Mozilla/5.0 (compatible; MnaqeeshMedia/1.0)',
        Accept: 'image/*,video/*;q=0.9,*/*;q=0.5'
      },
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    return NextResponse.json(
      { error: 'تعذر الوصول إلى الوسيط. قد تكون صلاحية رابط فيسبوك الموقّع قد انتهت.' },
      { status: 502 }
    );
  }

  if (!upstream.ok || !upstream.body) {
    const failedType = upstream.headers.get('content-type') ?? '';
    return NextResponse.json(
      { error: upstreamErrorMessage(upstream.status, failedType) },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!ALLOWED_MEDIA_CONTENT.test(contentType)) {
    // Real protection: even with a permissive URL, a non-media response is
    // never relayed to the client as a file.
    return NextResponse.json(
      { error: upstreamErrorMessage(200, contentType) },
      { status: 415 }
    );
  }

  const lengthHeader = upstream.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_MEDIA_BYTES) {
    return NextResponse.json({ error: 'حجم الوسيط أكبر من الحد المسموح.' }, { status: 413 });
  }

  const filename = safeMediaFilename(
    nameHint || decodeURIComponent(target.pathname.split('/').pop() || ''),
    contentType
  );

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ...(lengthHeader ? { 'Content-Length': lengthHeader } : {}),
      // `dl=1` forces a save; without it the route acts as an inline proxy
      // used for the thumbnails in the table.
      'Content-Disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
