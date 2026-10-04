/**
 * Validation helpers for the media download proxy.
 *
 * Kept separate from the route so they can be exercised directly: the
 * host block-list is the guard that stops the proxy being used to reach
 * internal services, so it deserves its own tests.
 */

/** Only these response types may be relayed to the browser. */
export const ALLOWED_MEDIA_CONTENT = /^(image\/|video\/|application\/octet-stream)/i;

/** A single media file larger than this is refused. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/** Hosts that must never be reached from the server (SSRF guard). */
export function isBlockedHost(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true;

  // IPv6 loopback / link-local written in full
  if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) return true;

  // IPv4 literals: private, loopback, link-local, and reserved ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a >= 224) return true; // multicast and reserved
  }

  return false;
}

/** True when the URL may be fetched by the proxy. */
export function isAllowedMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !isBlockedHost(url.hostname);
}

/** Picks a file extension for a content type. */
export function extensionFor(contentType: string): string {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  if (type.includes('mp4')) return '.mp4';
  if (type.includes('webm')) return '.webm';
  if (type.includes('quicktime')) return '.mov';
  if (type.startsWith('image/')) return '.jpg';
  if (type.startsWith('video/')) return '.mp4';
  return '.bin';
}

/**
 * Does this URL point at a media FILE, or at a web page?
 *
 * This matters because a post carries two different kinds of URL:
 *
 *   image_urls        -> often a facebook.com/photo/?fbid=… PAGE, which
 *                        returns HTML and can never be downloaded as an image
 *   image_direct_urls -> the fbcdn file itself, which is what we want
 *
 * The table must offer the direct file, falling back to the page URL only
 * when no direct one exists (so the button still does something useful).
 */
export function looksLikeMediaFile(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // A facebook.com page also ends in a slash, not a file extension.
  if (/\.(jpe?g|png|webp|gif|bmp|avif|mp4|webm|mov|m4v)(\?|$)/.test(path)) return true;

  // Facebook's CDN serves media from paths with no extension, so recognise
  // the CDN hosts explicitly (including /v/t39… and /v/t42… shapes).
  if (/(^|\.)fbcdn\.net$/.test(host)) return true;
  if (/\/v\/t\d+/.test(path)) return true;

  return false;
}

/**
 * Maps an upstream failure onto a message that tells the user what is
 * actually wrong.
 *
 * A 403 from Facebook's CDN means the *signature expired* — the link is a
 * real image link, it is just no longer valid. Saying "that is not an
 * image" in that case is misleading and sends people looking in the wrong
 * place.
 */
export function upstreamErrorMessage(status: number, contentType: string): string {
  if (status === 401 || status === 403) {
    return 'رابط الوسيط انتهت صلاحيته على فيسبوك. روابط الصور الموقّعة تنتهي بعد فترة، والحل إعادة حفظ المنشور من الإضافة لالتقاط رابط جديد.';
  }
  if (status === 404 || status === 410) {
    return 'الوسيط غير موجود على فيسبوك بعد الآن (ربما حُذف المنشور أو الصورة).';
  }
  if (status >= 500) {
    return 'فيسبوك لم يستجب بشكل صحيح. أعد المحاولة بعد قليل.';
  }
  if (!/^(image\/|video\/|application\/octet-stream)/i.test(contentType)) {
    return 'الرابط المحفوظ يشير إلى صفحة لا إلى ملف صورة/فيديو مباشر، لذا لا يمكن تنزيله.';
  }
  return `تعذر تحميل الوسيط من المصدر (HTTP ${status}).`;
}

/** Strips anything that could escape a directory or break a header. */
export function safeMediaFilename(raw: string, contentType: string, fallback = 'facebook-media'): string {
  const base = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  if (!base) return `${fallback}${extensionFor(contentType)}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}${extensionFor(contentType)}`;
}
