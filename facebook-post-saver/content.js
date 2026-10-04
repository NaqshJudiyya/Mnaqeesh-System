// Facebook Post Saver v2.12 — Content Script
// لا توجد طلبات شبكة ولا تنزيلات أثناء التصفح.
// كل التجميع يحدث فقط بعد ضغط المستخدم على زر «حفظ».

const SELECTORS = {
  post: '[role="article"]',
  message: [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-testid="post_message"]'
  ],
  postPermalinkHints: ['/posts/', '/permalink/', 'story_fbid=', '/story.php', '/share/p/', '/share/r/', '/videos/', '/reel/', '/watch/', '/notes/'],
  photoPermalinkHints: ['/photo/', '/photo.php', '/photos/', 'fbid='],
  videoHints: ['/videos/', '/reel/', '/watch/'],
  avatarHints: [
    'profile picture', 'الصورة الشخصية', 'صورة الملف الشخصي',
    'صورة ملفه الشخصي', 'صورة ملفها الشخصي'
  ],
  reactionHints: [
    'like', 'love', 'care', 'haha', 'wow', 'sad', 'angry',
    'إعجاب', 'حب', 'اهتمام', 'ضحك', 'استغراب', 'حزن', 'غضب', 'تأثر'
  ]
};

const JUNK_TEXT_PATTERNS = [
  /^تمت المشاركة مع/, /^shared with/i, /^منشور تمت مشاركته$/, /^shared post$/i,
  /^مؤشر حالة الاتصال/, /^نشط$/, /^active$/i, /^قد تكون صورة/, /^may be an image/i,
  /^see more$/i, /^see translation$/i, /^شاهد المزيد$/, /^شاهد الترجمة$/,
  /^تعليق باسم/, /^comment by/i, /^like$/i, /^comment$/i, /^share$/i,
  /^إعجاب$/, /^تعليق$/, /^مشاركة$/
];

const relativeUnitMs = {
  'ث': 1000, 'ثانية': 1000, 'ثوان': 1000, 'ثانيتين': 2000, 'second': 1000, 'seconds': 1000, 'sec': 1000, 's': 1000,
  'د': 60000, 'دقيقة': 60000, 'دقائق': 60000, 'دقيقتين': 120000, 'minute': 60000, 'minutes': 60000, 'min': 60000, 'm': 60000,
  'س': 3600000, 'ساعة': 3600000, 'ساعات': 3600000, 'ساعتين': 7200000, 'hour': 3600000, 'hours': 3600000, 'hr': 3600000, 'h': 3600000,
  'يوم': 86400000, 'أيام': 86400000, 'يومين': 172800000, 'day': 86400000, 'days': 86400000, 'd': 86400000,
  'أسبوع': 604800000, 'أسابيع': 604800000, 'أسبوعين': 1209600000, 'week': 604800000, 'weeks': 604800000, 'w': 604800000,
  'شهر': 2592000000, 'أشهر': 2592000000, 'سنة': 31536000000, 'سنوات': 31536000000,
  'y': 31536000000
};

let savedPostIds = new Set();
let scanTimer = null;
const queuedPostElements = new Set();

function normalizeDigits(value) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  return String(value || '')
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianDigits.indexOf(d)));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isJunkText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return JUNK_TEXT_PATTERNS.some((re) => re.test(t));
}

function simpleHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getAttributeUrl(el, attrs = ['href']) {
  if (!el?.getAttribute) return '';
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (value) return String(value).trim();
  }
  return '';
}

function getElementUrl(el) {
  return getAttributeUrl(el, [
    'href', 'data-href', 'data-uri', 'data-url', 'data-permalink', 'data-imgpermalink',
    'ajaxify', 'data-ajaxify'
  ]);
}

function isFacebookHost(url) {
  try {
    const hostname = new URL(url, location.origin).hostname;
    return /(^|\.)facebook\.com$/i.test(hostname) || /(^|\.)fbcdn\.net$/i.test(hostname);
  } catch {
    return false;
  }
}

function canonicalizeFacebookUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl, location.origin);
    if (!isFacebookHost(url.href)) return url.href;

    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // روابط الصور/المنشورات التي تحتاج query parameters حتى تبقى صالحة.
    const keepAllQuery = /\/(?:share|reel|videos?|watch|posts|permalink|photos?)\b/i.test(path);
    if (keepAllQuery) {
      // نحذف tracking فقط ونبقي المعلمات التي قد تكون جزءًا من الرابط نفسه.
      const tracking = new Set(['__cft__', '__tn__', 'ref', 'refid', 'notif_id', 'notif_t', 'comment_tracking']);
      for (const key of [...url.searchParams.keys()]) {
        if (tracking.has(key)) url.searchParams.delete(key);
      }
      const query = url.searchParams.toString();
      return query ? `${url.origin}${path}?${query}` : `${url.origin}${path}`;
    }

    const query = new URLSearchParams();
    for (const key of ['story_fbid', 'id', 'fbid', 'v', 'set']) {
      if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key));
    }
    return query.toString() ? `${url.origin}${path}?${query}` : `${url.origin}${path}`;
  } catch {
    return rawUrl;
  }
}

function getAbsoluteUrl(href) {
  if (!href) return '';
  try {
    const url = new URL(href, location.origin);
    if (!/^https?:$/i.test(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function getLinkLabel(link) {
  return [
    link?.getAttribute?.('aria-label'), link?.getAttribute?.('title'),
    link?.getAttribute?.('data-tooltip-content'), link?.textContent
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function isCommentOrReplyUrl(rawUrl) {
  const value = String(rawUrl || '').toLowerCase();
  return /comment_id=|reply_comment_id=|\/comments\//i.test(value);
}

function isPostPermalink(rawUrl) {
  const value = String(rawUrl || '').toLowerCase();
  if (!value || isCommentOrReplyUrl(value)) return false;
  return [
    '/posts/', '/permalink/', '/story.php', 'story_fbid=',
    '/share/p/', '/share/r/', '/videos/', '/video/', '/reel/', '/watch/', '/notes/'
  ].some((hint) => value.includes(hint));
}

function isPhotoPageUrl(rawUrl) {
  const value = String(rawUrl || '').toLowerCase();
  if (!value || isCommentOrReplyUrl(value)) return false;
  return [
    '/photo/', '/photo.php', '/photos/', 'fbid='
  ].some((hint) => value.includes(hint));
}

function scorePermalinkCandidate(link, index, anchorHint) {
  if (!link) return -Infinity;
  const raw = getElementUrl(link);
  const absolute = getAbsoluteUrl(raw);
  if (!absolute || isCommentOrReplyUrl(absolute)) return -Infinity;

  const label = getLinkLabel(link);
  let score = 0;
  if (isPostPermalink(absolute)) score += 180;
  if (link === anchorHint) score += 90;
  if (timestampFromElement(link)) score += 70;
  if (parseAbsoluteDateTime(label)) score += 55;
  if (parseDateParts(label)) score += 25;
  if (parseTimeParts(label)) score += 20;
  if (link.closest('header')) score += 25;
  score += Math.max(0, 15 - index);
  if (isPhotoPageUrl(absolute)) score += 10;
  return score;
}

function findPermalinkAnchor(postEl) {
  const links = Array.from(postEl?.querySelectorAll?.('a[href], [data-href], [data-uri], [data-url], [data-permalink], [ajaxify], [data-ajaxify]') || []);
  if (!links.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (isNestedArticleElement(link, postEl)) continue;
    const score = scorePermalinkCandidate(link, index, null);
    if (score > bestScore) {
      bestScore = score;
      best = link;
    }
  }
  return bestScore >= 160 ? best : null;
}

function extractPermalink(postEl) {
  const links = Array.from(postEl?.querySelectorAll?.('a[href], [data-href], [data-uri], [data-url], [data-permalink], [ajaxify], [data-ajaxify]') || []);
  if (!links.length) return '';

  let bestUrl = '';
  let bestScore = -Infinity;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (isNestedArticleElement(link, postEl)) continue;
    const raw = getElementUrl(link);
    const absolute = getAbsoluteUrl(raw);
    if (!absolute || isCommentOrReplyUrl(absolute)) continue;
    let score = scorePermalinkCandidate(link, index, null);

    const label = getLinkLabel(link);
    if (timestampFromElement(link)) score += 60;
    if (parseAbsoluteDateTime(label) || parseRelativeOffsetMs(label) !== null) score += 70;

    // Prefer a real post URL over a timestamp/image URL.
    if (isPostPermalink(absolute)) score += 180;
    if (isPhotoPageUrl(absolute) && !isPostPermalink(absolute)) score -= 35;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = absolute;
    }
  }

  return canonicalizeFacebookUrl(bestUrl);
}

function parseRelativeOffsetMs(text) {
  let t = normalizeDigits(text).trim().toLowerCase();
  if (!t) return null;

  t = t.replace(/^منذ\s+/, '').replace(/^قبل\s+/, '').replace(/\s+ago$/, '');
  if (/^(الآن|منذ لحظات|just now|now)$/.test(t)) return 0;
  if (/^(أمس|امس|yesterday)$/.test(t)) return 86400000;

  const single = relativeUnitMs[t];
  if (single !== undefined) return single;

  const match = t.match(/^(\d+)\s*(ث|ثانية|ثوان|د|دقيقة|دقائق|س|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع|شهر|أشهر|سنة|سنوات|second|seconds|sec|minute|minutes|min|hour|hours|hr|day|days|week|weeks|s|m|h|d|w|y)\.?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = relativeUnitMs[match[2].toLowerCase()];
  return Number.isFinite(amount) && unit ? amount * unit : null;
}

function parseTimeParts(text) {
  const t = normalizeDigits(String(text || ''))
    .replace(/[٫。]/g, ':')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!t) return null;

  // يدعم 18:55 / 6:55 PM / 6:55 م / 18.55.
  const match = t.match(/(^|[^0-9])(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|صباحًا|صباحا|مساءً|مساءا|ص|م)?(?=$|[^0-9])/i);
  if (!match) return null;

  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  const meridiem = (match[5] || '').toLowerCase().replace(/\./g, '');

  if (minute > 59 || second > 59 || hour > 23) return null;

  if ((meridiem === 'pm' || meridiem === 'p m' || meridiem === 'مساءً' || meridiem === 'مساءا' || meridiem === 'م') && hour < 12) hour += 12;
  if ((meridiem === 'am' || meridiem === 'a m' || meridiem === 'صباحًا' || meridiem === 'صباحا' || meridiem === 'ص') && hour === 12) hour = 0;

  // 12-hour labels بدون AM/PM لا يمكننا افتراض أنها صباحًا/مساءً،
  // لكن Facebook عادة يضع علامة الفترة في نفس النص. نسمح بالقيم 1..12
  // هنا لأن التاريخ/الوقت سيأتيان من مصدر موثوق داخل المنشور.
  return { hour, minute, second, explicitMeridiem: Boolean(meridiem) };
}

function parseDateParts(text, now = new Date()) {
  const original = String(text || '').trim();
  if (!original) return null;

  const normalized = normalizeDigits(original)
    .replace(/\u00a0/g, ' ')
    .replace(/[،,|·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const monthsAr = {
    يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, أبريل: 4, مايو: 5,
    يونيو: 6, يونية: 6, يوليو: 7, يوليه: 7, اغسطس: 8, أغسطس: 8,
    سبتمبر: 9, اكتوبر: 10, أكتوبر: 10, نوفمبر: 11, ديسمبر: 12
  };
  const monthsEn = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };

  // اليوم/أمس مع أو بدون وقت.
  if (/\b(?:اليوم|today)\b/i.test(normalized)) return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  if (/\b(?:أمس|امس|yesterday)\b/i.test(normalized)) {
    const d = new Date(now.getTime() - 86400000);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  let day = null;
  let month = null;
  let year = null;

  const iso = normalized.match(/(?:^|\D)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=$|\D)/);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  }

  if (!day) {
    const fullNumeric = normalized.match(/(?:^|\D)(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?=$|\D)/);
    if (fullNumeric) {
      const a = Number(fullNumeric[1]);
      const b = Number(fullNumeric[2]);
      if (a > 12 && b <= 12) { day = a; month = b; }
      else { day = a; month = b; }
      year = Number(fullNumeric[3]);
    }
  }

  if (!day) {
    const ar = normalized.match(/(?:^|\s)(\d{1,2})\s+(?:ال)?([أ-ئ]+)(?:\s+(\d{4}))?(?=\s|$)/);
    if (ar) {
      const keyRaw = ar[2].replace(/^ال/, '');
      const key = Object.keys(monthsAr).find((m) => m === keyRaw || m.includes(keyRaw) || keyRaw.includes(m));
      if (key) { day = Number(ar[1]); month = monthsAr[key]; year = ar[3] ? Number(ar[3]) : null; }
    }
  }

  if (!day) {
    const en1 = normalized.match(/(?:^|\s)([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?=\s|$)/i);
    if (en1 && monthsEn[en1[1].toLowerCase()]) {
      month = monthsEn[en1[1].toLowerCase()]; day = Number(en1[2]); year = en1[3] ? Number(en1[3]) : null;
    }
  }

  if (!day) {
    const en2 = normalized.match(/(?:^|\s)(\d{1,2})\s+([A-Za-z]+)(?:,?\s+(\d{4}))?(?=\s|$)/i);
    if (en2 && monthsEn[en2[2].toLowerCase()]) {
      day = Number(en2[1]); month = monthsEn[en2[2].toLowerCase()]; year = en2[3] ? Number(en2[3]) : null;
    }
  }

  if (!day) {
    const shortNumeric = normalized.match(/(?:^|\D)(\d{1,2})[/.](\d{1,2})(?=$|\D)/);
    if (shortNumeric) {
      day = Number(shortNumeric[1]); month = Number(shortNumeric[2]); year = now.getFullYear();
    }
  }

  if (!day || !month || day < 1 || day > 31 || month < 1 || month > 12) return null;

  if (!year) {
    year = now.getFullYear();
    const candidate = new Date(year, month - 1, day, 23, 59, 59);
    if (candidate.getTime() > now.getTime() + 2 * 86400000) year -= 1;
  }

  const check = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(check.getTime()) || check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null;
  return { year, month, day };
}

function parseAbsoluteDateTime(text, now = new Date()) {
  const source = String(text || '');
  const dateParts = parseDateParts(source, now);
  const timeParts = parseTimeParts(source);
  if (!dateParts || !timeParts) return null;
  return new Date(dateParts.year, dateParts.month - 1, dateParts.day, timeParts.hour, timeParts.minute, timeParts.second, 0);
}

function parseFacebookTimestampText(text, now = new Date()) {
  const source = normalizeDigits(String(text || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return null;

  const absolute = parseAbsoluteDateTime(source, now);
  if (absolute) return absolute;

  // Facebook: Today at 6:45 PM / Yesterday at 6:45 PM / اليوم الساعة 18:45.
  const time = parseTimeParts(source);
  if (time && /\b(?:اليوم|today)\b/i.test(source)) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, time.second, 0);
  }
  if (time && /\b(?:أمس|امس|yesterday)\b/i.test(source)) {
    const d = new Date(now.getTime() - 86400000);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.hour, time.minute, time.second, 0);
  }

  const offset = parseRelativeOffsetMs(source.replace(/^(?:منذ|قبل)\s*/i, '').trim());
  if (offset !== null) return new Date(now.getTime() - offset);

  // نص نسبي أطول: منذ 3 أيام الساعة 18:00.
  const relativeMatch = source.match(/(?:منذ|قبل)\s+(\d+)\s*(ثانية|ثوان|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع|شهر|أشهر|سنة|سنوات|second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|[smhdwy])/i);
  if (relativeMatch) {
    const relativeText = relativeMatch[0];
    const relativeOffset = parseRelativeOffsetMs(relativeText);
    if (relativeOffset !== null) {
      const base = new Date(now.getTime() - relativeOffset);
      return time
        ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.hour, time.minute, time.second, 0)
        : base;
    }
  }

  return null;
}

function timestampFromElement(el) {
  if (!el) return null;

  // Unix timestamps: هذه أقوى إشارة ونتعامل معها قبل أي نص مرئي.
  for (const attr of ['data-utime', 'data-time', 'data-timestamp', 'data-ts', 'data-created-at', 'data-time-ms']) {
    const raw = el.getAttribute?.(attr);
    const value = Number(normalizeDigits(raw));
    if (Number.isFinite(value) && value > 1000000000) {
      const ms = value > 100000000000 ? value : value * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  // datetime قد يحتوي على تاريخ فقط (2026-09-23)، وهذا ليس وقتًا.
  // لا نرجعه كـ 00:00؛ نترك التاريخ فقط للـparser حتى نتمكن من دمجه
  // مع وقت موجود في عنصر آخر.
  const datetime = el.getAttribute?.('datetime');
  if (datetime && /\d[T\s]\d{1,2}:\d{2}/.test(datetime)) {
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // لا نفحص كل attributes عشوائيًا؛ أرقام Facebook IDs قد تشبه Unix timestamps
  // وتؤدي إلى تاريخ/وقت خاطئ. نعتمد فقط على attributes المعروفة للوقت.
  return null;
}

function domDistance(a, b, max = 12) {
  if (!a || !b) return max + 1;
  if (a === b) return 0;
  const ancestors = new Map();
  let cur = a;
  for (let i = 0; cur && i <= max; i += 1, cur = cur.parentElement) ancestors.set(cur, i);
  cur = b;
  for (let i = 0; cur && i <= max; i += 1, cur = cur.parentElement) {
    if (ancestors.has(cur)) return ancestors.get(cur) + i;
  }
  return max + 1;
}


function isNestedArticleElement(el, rootArticle) {
  if (!el || !rootArticle) return false;
  let current = el.parentElement;
  while (current && current !== rootArticle) {
    if (current.matches?.('[role="article"]')) return true;
    current = current.parentElement;
  }
  return false;
}

function isPrimaryPostElement(postEl) {
  if (!(postEl instanceof Element)) return false;
  let parent = postEl.parentElement;
  while (parent) {
    if (parent.matches?.('[role="article"]')) return false;
    parent = parent.parentElement;
  }
  return true;
}

function getTimestampSignalText(el) {
  return [
    el?.innerText,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
    el?.getAttribute?.('data-tooltip-content'),
    el?.getAttribute?.('data-tooltip'),
    el?.getAttribute?.('data-content'),
    el?.getAttribute?.('data-original-title'),
    el?.getAttribute?.('datetime')
  ].filter(Boolean).map((v) => String(v).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parseIsoDateParts(raw, now = new Date()) {
  const value = String(raw || '').trim();
  const match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return parseDateParts(`${day}/${month}/${year}`, now);
}

function timestampInfoFromElement(el, now = new Date()) {
  if (!el) return null;

  const visibleText = String(el.innerText || '').replace(/\s+/g, ' ').trim();
  const signalTexts = getTimestampSignalText(el);
  const allText = signalTexts.join(' ');
  const datetimeAttr = el.getAttribute?.('datetime') || '';

  // لو عندنا Unix timestamp حقيقي على نفس عنصر وقت المنشور، فهو أدق مصدر.
  const epochDate = timestampFromElement(el);

  // الأولوية للوقت الظاهر للمستخدم إذا كان موجودًا على نفس عنصر الـtimestamp؛
  // بهذا لا نعوّض 21:29 بقيمة مختلفة من timezone/attribute آخر.
  const visibleTime = parseTimeParts(visibleText);
  const allTime = parseTimeParts(allText);
  const dateFromText = parseDateParts(allText, now);
  const dateFromDatetime = parseIsoDateParts(datetimeAttr, now);

  const fullTextDateTime = parseAbsoluteDateTime(allText, now);
  if (fullTextDateTime) {
    return {
      date: formatDate(fullTextDateTime),
      time: visibleTime ? formatTimeParts(visibleTime) : formatTime(fullTextDateTime),
      exact: true,
      visibleExact: Boolean(visibleTime),
      source: 'text'
    };
  }

  let dateParts = dateFromText || dateFromDatetime;
  let timeParts = visibleTime || allTime;

  if (!dateParts && epochDate) {
    dateParts = { year: epochDate.getFullYear(), month: epochDate.getMonth() + 1, day: epochDate.getDate() };
  }

  if (!timeParts && epochDate) {
    timeParts = { hour: epochDate.getHours(), minute: epochDate.getMinutes(), second: epochDate.getSeconds() };
  }

  if (!dateParts || !timeParts) return null;

  return {
    date: `${pad2(dateParts.day)}/${pad2(dateParts.month)}/${dateParts.year}`,
    time: formatTimeParts(timeParts),
    exact: Boolean(epochDate || datetimeAttr),
    visibleExact: Boolean(dateParts && timeParts && (visibleTime || dateFromText)),
    source: epochDate ? 'epoch' : datetimeAttr ? 'datetime' : 'text'
  };
}

function formatTimeParts(parts) {
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function isTemporalCandidateElement(el, postEl) {
  if (!el || isNestedArticleElement(el, postEl)) return false;
  const tag = el.tagName?.toLowerCase();
  if (['time', 'abbr'].includes(tag)) return true;
  if (['a'].includes(tag) && (isPostPermalink(getAbsoluteUrl(getElementUrl(el))) || timestampFromElement(el))) return true;
  return [
    'datetime', 'data-utime', 'data-time', 'data-timestamp', 'data-ts', 'data-created-at',
    'data-time-ms', 'aria-label', 'title', 'data-tooltip-content', 'data-tooltip',
    'data-content', 'data-original-title'
  ].some((attr) => el.hasAttribute?.(attr));
}

function findDateTimeCandidates(postEl, anchorEl) {
  const out = [];
  const seen = new Set();
  const push = (el, priority = 0) => {
    if (!el || seen.has(el) || isNestedArticleElement(el, postEl)) return;
    seen.add(el);
    const texts = getTimestampSignalText(el);
    const combined = texts.join(' ');
    const info = timestampInfoFromElement(el);
    const temporal = info || /\d{1,2}:\d{2}|(?:منذ|قبل|ago|today|yesterday|اليوم|أمس|امس)|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?|\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/i.test(combined);
    if (!temporal) return;
    out.push({ el, text: combined, priority, distance: anchorEl ? domDistance(anchorEl, el) : 20, info });
  };

  // أهم مصدر: رابط الوقت الخاص بالمنشور نفسه.
  if (anchorEl) push(anchorEl, 520);
  if (anchorEl?.parentElement) push(anchorEl.parentElement, 480);
  if (anchorEl?.parentElement?.parentElement) push(anchorEl.parentElement.parentElement, 440);

  const header = anchorEl?.closest?.('header') || postEl.querySelector?.('header');
  if (header) {
    push(header, 360);
    for (const el of header.querySelectorAll('time, abbr, a[href], [datetime], [data-utime], [data-time], [data-timestamp], [data-ts], [data-created-at], [data-time-ms], [aria-label], [title], [data-tooltip-content], [data-tooltip]')) {
      if (isTemporalCandidateElement(el, postEl)) push(el, 340);
    }
  }

  // بعض تخطيطات Facebook لا تستخدم header؛ نبحث في عناصر timestamp الصريحة
  // فقط، مع استبعاد أي article متداخل (تعليقات/ردود).
  const selector = [
    'time', 'abbr', '[datetime]', '[data-utime]', '[data-time]', '[data-timestamp]',
    '[data-ts]', '[data-created-at]', '[data-time-ms]',
    'a[aria-label]', 'a[title]', 'a[data-tooltip-content]',
    'abbr[title]', 'span[aria-label]', 'span[title]',
    '[data-tooltip]', '[data-content]', '[data-original-title]'
  ].join(',');

  for (const el of postEl.querySelectorAll(selector)) {
    if (!isTemporalCandidateElement(el, postEl)) continue;
    push(el, el.closest?.('header') ? 300 : 120);
    if (out.length > 600) break;
  }

  return out.sort((a, b) => {
    const aExact = a.info?.exact ? 1 : 0;
    const bExact = b.info?.exact ? 1 : 0;
    return (bExact - aExact) || (b.priority - a.priority) || (a.distance - b.distance);
  });
}

function findBestTimestampAnchor(postEl, permalinkAnchor = null) {
  if (!postEl) return permalinkAnchor || null;

  const selector = [
    'time', 'abbr', 'a[href]', '[datetime]', '[data-utime]', '[data-time]', '[data-timestamp]',
    '[data-ts]', '[data-created-at]', '[data-time-ms]', '[aria-label]', '[title]',
    '[data-tooltip-content]', '[data-tooltip]', '[data-content]', '[data-original-title]'
  ].join(',');

  let best = permalinkAnchor || null;
  let bestScore = permalinkAnchor ? 1000 : -Infinity;

  const score = (el) => {
    if (!el || isNestedArticleElement(el, postEl)) return -Infinity;
    const texts = getTimestampSignalText(el);
    const combined = texts.join(' ');
    if (!combined) return -Infinity;

    const info = timestampInfoFromElement(el);
    const absolute = parseAbsoluteDateTime(combined);
    const date = parseDateParts(combined);
    const time = parseTimeParts(combined);
    const relative = parseFacebookTimestampText(combined);
    if (!info && !absolute && !date && !time && !relative) return -Infinity;

    let value = 0;
    if (el === permalinkAnchor) value += 450;
    if (info?.visibleExact) value += 420;
    else if (absolute) value += 380;
    else if (info?.exact) value += 260;
    if (date) value += 100;
    if (time) value += 110;
    if (info?.source === 'epoch') value += 40;
    if (['time', 'abbr'].includes(el.tagName?.toLowerCase())) value += 70;
    if (el.closest('header')) value += 90;
    if (isPostPermalink(getAbsoluteUrl(getElementUrl(el)))) value += 80;
    if (/(?:منذ|قبل|ago|yesterday|today|اليوم|أمس|امس|\b\d+\s*[smhdwy]\b)/i.test(combined)) value += 15;

    const distance = permalinkAnchor ? domDistance(permalinkAnchor, el, 10) : 20;
    value -= Math.min(distance, 12) * 4;
    return value;
  };

  let index = 0;
  for (const el of postEl.querySelectorAll(selector)) {
    if (index++ > 900) break;
    const value = score(el);
    if (value > bestScore) { bestScore = value; best = el; }
  }

  return best;
}

function getTightTimestampElements(postEl, anchorEl) {
  const out = [];
  const seen = new Set();
  const add = (el, distance = 0, priority = 0) => {
    if (!el || seen.has(el) || isNestedArticleElement(el, postEl)) return;
    seen.add(el);
    out.push({ el, distance, priority });
  };

  if (anchorEl) {
    add(anchorEl, 0, 900);
    // لا نأخذ header كاملًا لأن هذا قد يضم أوقاتًا أخرى مثل أوقات التعليقات.
    let current = anchorEl.parentElement;
    for (let d = 1; current && d <= 3 && current !== postEl; d += 1, current = current.parentElement) {
      add(current, d, 800 - d * 80);
      for (const child of current.querySelectorAll('time, abbr, [datetime], [data-utime], [data-time], [data-timestamp], [data-ts], [data-created-at], [data-time-ms]')) {
        if (child === anchorEl || isNestedArticleElement(child, postEl)) continue;
        const childDistance = domDistance(anchorEl, child, 8);
        if (childDistance <= 6) add(child, childDistance, 760 - childDistance * 25);
      }
      if (current.querySelectorAll('time, abbr, [datetime], [data-utime], [data-time], [data-timestamp]').length > 12) break;
    }
  }

  // مصادر timestamp الصريحة، مرتبة حسب قربها من رابط المنشور.
  for (const el of postEl.querySelectorAll('time, abbr, [datetime], [data-utime], [data-time], [data-timestamp], [data-ts], [data-created-at], [data-time-ms]')) {
    if (isNestedArticleElement(el, postEl)) continue;
    const distance = anchorEl ? domDistance(anchorEl, el, 12) : 12;
    if (distance <= 10) add(el, distance, 620 - distance * 20);
  }

  return out.sort((a, b) => (b.priority - a.priority) || (a.distance - b.distance));
}

function parseTightTimestampCandidate(el, now) {
  if (!el) return null;
  const attrs = [
    el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
    el.getAttribute?.('data-tooltip-content'), el.getAttribute?.('data-content'),
    el.getAttribute?.('datetime')
  ].filter(Boolean).map((v) => String(v).replace(/\s+/g, ' ').trim());
  const visible = String(el.innerText || '').replace(/\s+/g, ' ').trim();
  const sources = [...new Set([visible, ...attrs].filter(Boolean))];

  // افحص كل مصدر منفردًا أولًا حتى لا يختلط وقت المنشور بوقت عنصر آخر في نفس الحاوية.
  for (const source of sources) {
    const info = timestampInfoFromElement(el, now);
    if (info?.date && info?.time && info.visibleExact) return { date: info.date, time: info.time, raw: source, exact: true, visibleExact: true };
    const absolute = parseAbsoluteDateTime(source, now);
    if (absolute) return { date: formatDate(absolute), time: formatTime(absolute), raw: source, exact: true, visibleExact: Boolean(parseTimeParts(visible)) };
  }

  // إذا كان datetime يحتوي على التاريخ فقط، ادمجه فقط مع وقت موجود على نفس العنصر.
  const dateSource = sources.find((s) => parseDateParts(s, now) || parseIsoDateParts(s, now));
  const timeSource = sources.find((s) => parseTimeParts(s));
  if (dateSource && timeSource) {
    const dateParts = parseDateParts(dateSource, now) || parseIsoDateParts(dateSource, now);
    const timeParts = parseTimeParts(timeSource);
    if (dateParts && timeParts) {
      return {
        date: `${pad2(dateParts.day)}/${pad2(dateParts.month)}/${dateParts.year}`,
        time: formatTimeParts(timeParts),
        raw: `${dateSource} | ${timeSource}`,
        exact: true,
        visibleExact: Boolean(parseTimeParts(visible))
      };
    }
  }

  return null;
}

function isVisibleElement(el) {
  if (!(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function extractAbsoluteTimestampFromElement(el, now = new Date()) {
  if (!el) return null;

  const tag = el.tagName?.toLowerCase();
  const allowsVisibleText = ['time', 'abbr', 'a'].includes(tag);

  const directEpoch = timestampFromElement(el);
  if (directEpoch) {
    return {
      date: formatDate(directEpoch),
      time: formatTime(directEpoch),
      raw: getTimestampSignalText(el).join(' | ') || directEpoch.toISOString(),
      exact: true,
      visibleExact: true,
      source: 'epoch'
    };
  }

  // datetime الكامل قد يحتوي timezone؛ نستخدم Date مباشرة حتى لا نخطئ في تحويل الوقت.
  const datetime = String(el.getAttribute?.('datetime') || '').trim();
  if (datetime && /\d[T\s]\d{1,2}:\d{2}/.test(datetime)) {
    const parsedDatetime = new Date(datetime);
    if (!Number.isNaN(parsedDatetime.getTime())) {
      return {
        date: formatDate(parsedDatetime),
        time: formatTime(parsedDatetime),
        raw: datetime,
        exact: true,
        visibleExact: allowsVisibleText && Boolean(parseTimeParts(String(el.innerText || ''))),
        source: 'datetime'
      };
    }
  }

  const attributeSources = [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('data-tooltip-content'),
    el.getAttribute?.('data-tooltip'),
    el.getAttribute?.('data-content'),
    el.getAttribute?.('data-original-title')
  ].filter(Boolean).map((value) => String(value).replace(/\s+/g, ' ').trim());

  const sources = [
    ...(allowsVisibleText ? [String(el.innerText || '').replace(/\s+/g, ' ').trim()] : []),
    ...attributeSources
  ].filter(Boolean);

  for (const source of [...new Set(sources)]) {
    const parsed = parseAbsoluteDateTime(source, now);
    if (!parsed) continue;
    return {
      date: formatDate(parsed),
      time: formatTime(parsed),
      raw: source,
      exact: true,
      visibleExact: allowsVisibleText && source === String(el.innerText || '').replace(/\s+/g, ' ').trim(),
      source: 'absolute'
    };
  }

  return null;
}

async function readExactTimestampAfterHover(postEl, anchorEl, timeoutMs = 900) {
  if (!anchorEl) return null;

  const describedByIds = () => String(anchorEl.getAttribute?.('aria-describedby') || '')
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const inspect = () => {
    const candidates = [
      anchorEl,
      ...describedByIds(),
      ...Array.from(document.querySelectorAll(
        '[role="tooltip"], [data-testid*="tooltip" i], [aria-label][data-tooltip-content]'
      ))
    ];

    const seen = new Set();
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate) || !isVisibleElement(candidate)) continue;
      seen.add(candidate);

      const parsed = extractAbsoluteTimestampFromElement(candidate);
      if (parsed?.date && parsed?.time) return parsed;

      const text = getTimestampSignalText(candidate).join(' ');
      const absolute = parseAbsoluteDateTime(text);
      if (absolute) {
        return {
          date: formatDate(absolute),
          time: formatTime(absolute),
          raw: text,
          exact: true,
          visibleExact: true,
          source: 'tooltip'
        };
      }
    }
    return null;
  };

  const immediate = inspect();
  if (immediate) return immediate;

  const original = document.activeElement;
  try {
    anchorEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    anchorEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
    if (typeof PointerEvent === 'function') {
      anchorEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
      anchorEl.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: true, pointerType: 'mouse' }));
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = inspect();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } catch (error) {
    console.debug('[Facebook Post Saver] timestamp hover inspection skipped:', error);
  } finally {
    try {
      anchorEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window }));
      anchorEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, view: window }));
      if (original instanceof HTMLElement && document.contains(original)) {
        original.focus({ preventScroll: true });
      }
    } catch {}
  }

  return null;
}

function resolveDateTime(postEl, anchorEl, exactTimestamp = null) {
  const now = new Date();
  if (exactTimestamp?.date && exactTimestamp?.time) return exactTimestamp;

  const temporalAnchor = findBestTimestampAnchor(postEl, anchorEl);
  const tightElements = getTightTimestampElements(postEl, temporalAnchor);

  // 1) لا نسمح بخلط ساعة المنشور مع دقائق وقت الضغط.
  // نبحث أولًا عن timestamp مطلق/دقيق على نفس عنصر المنشور أو attributes المرتبطة به.
  for (const candidate of tightElements) {
    const exact = extractAbsoluteTimestampFromElement(candidate.el, now);
    if (exact?.date && exact?.time) return exact;
  }

  // 2) لا ندمج تاريخًا من عنصر مع وقت نسبي/حالي من عنصر آخر.
  let bestDate = null;
  let bestTime = null;
  for (const candidate of tightElements) {
    const tag = candidate.el.tagName?.toLowerCase();
    const hasExplicitTimestampAttribute = ['datetime', 'data-utime', 'data-time', 'data-timestamp', 'data-ts', 'data-created-at', 'data-time-ms']
      .some((attr) => candidate.el.hasAttribute?.(attr));
    const hasTimestampLabel = ['aria-label', 'title', 'data-tooltip-content', 'data-tooltip', 'data-content', 'data-original-title']
      .some((attr) => candidate.el.hasAttribute?.(attr));

    // لا نستخدم innerText للحاويات العامة؛ وقت التعليقات أو النصوص الأخرى قد يظهر داخلها.
    if (!['time', 'abbr', 'a'].includes(tag) && !hasExplicitTimestampAttribute && !hasTimestampLabel) continue;

    const info = timestampInfoFromElement(candidate.el, now);
    if (!info) continue;

    const raw = getTimestampSignalText(candidate.el).join(' | ');
    const isRelativeOnly = /(?:منذ|قبل|ago|\b\d+\s*[smhdwy]\b)/i.test(raw)
      && !parseAbsoluteDateTime(raw, now)
      && !timestampFromElement(candidate.el);

    if (info.date && !isRelativeOnly && (!bestDate || candidate.priority > bestDate.priority || candidate.distance < bestDate.distance)) {
      bestDate = { ...candidate, date: info.date, raw };
    }
    if (info.time && !isRelativeOnly && (!bestTime || candidate.priority > bestTime.priority || candidate.distance < bestTime.distance)) {
      bestTime = { ...candidate, time: info.time, raw };
    }
  }

  if (bestDate?.date && bestTime?.time) {
    return {
      date: bestDate.date,
      time: bestTime.time,
      raw: [bestDate.raw, bestTime.raw].filter(Boolean).join(' | '),
      exact: true,
      visibleExact: true
    };
  }

  // لا نستخدم "منذ X ساعات" كوقت دقيق؛ ذلك كان سبب خلط دقائق وقت الحفظ بالمنشور.
  return { date: '', time: '', raw: '' };
}

function nearbyScope(el, root, levels = 4) {
  let current = el;
  for (let i = 0; i < levels; i += 1) {
    if (!current?.parentElement || current.parentElement === root) break;
    current = current.parentElement;
  }
  return current || root;
}

function normalizeLabel(value) {
  return String(value || '')
    .replace(/\u200f|\u200e/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractPrivacy(postEl, anchorEl) {
  // فيسبوك قد يضع وصف الجمهور في aria-label/title/data-tooltip-content
  // على الأيقونة نفسها، وقد تكون الأيقونة بعيدة نسبيًا عن رابط الوقت.
  // لذلك نبحث أولًا في منطقة الرأس ثم في المنشور كله، مع إعطاء أولوية
  // للكلمات الدالة الدقيقة ومنع التقاط نص التعليقات قدر الإمكان.
  const primaryScope = anchorEl ? nearbyScope(anchorEl, postEl, 7) : postEl;
  const scopes = primaryScope === postEl ? [postEl] : [primaryScope, postEl];

  const publicWords = ['public', 'عام', 'عامه', 'عامة'];
  const friendWords = ['friends', 'friend', 'اصدقاء', 'أصدقاء', 'للأصدقاء', 'للاصدقاء'];
  const privateWords = ['only me', 'انا فقط', 'أنا فقط'];

  const inspect = (root, allowVisibleText) => {
    const elements = Array.from(root.querySelectorAll('[aria-label], [title], [data-tooltip-content], [data-content], [role="img"]'));
    for (const el of elements) {
      const raw = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-tooltip-content'),
        el.getAttribute('data-content')
      ].filter(Boolean).join(' ');
      const label = normalizeLabel(raw);
      if (!label) continue;
      if (privateWords.some((word) => label.includes(normalizeLabel(word)))) return 'private';
      if (publicWords.some((word) => label === normalizeLabel(word) || label.includes(` ${normalizeLabel(word)} `) || label.includes(normalizeLabel(word)))) return 'public';
      if (friendWords.some((word) => label === normalizeLabel(word) || label.includes(` ${normalizeLabel(word)} `) || label.includes(normalizeLabel(word)))) return 'friends';
    }

    if (!allowVisibleText) return null;

    // fallback: النص الظاهر في رأس المنشور قد يحتوي على "عام" أو "للأصدقاء".
    const textNodes = Array.from(root.querySelectorAll('span, div'))
      .slice(0, 180)
      .map((el) => normalizeLabel(el.textContent))
      .filter((text) => text && text.length <= 40);
    if (textNodes.some((text) => /^عام(?:ه)?$/.test(text))) return 'public';
    if (textNodes.some((text) => /^(?:للاصدقاء|اصدقاء)$/.test(text))) return 'friends';
    return null;
  };

  for (const [index, scope] of scopes.entries()) {
    const result = inspect(scope, index === scopes.length - 1);
    if (result) return result;
  }
  return 'unknown';
}

function cleanAuthorText(raw) {
  return String(raw || '')
    .replace(/^مؤشر حالة الاتصال\s*/i, '')
    .replace(/^نشط\s*/i, '')
    .replace(/^(active|online)\s*/i, '')
    .replace(/^صورة ملفه الشخصي\s*/i, '')
    .replace(/^صورة ملفها الشخصي\s*/i, '')
    .replace(/^profile picture\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isLikelyPermalinkHref(href) {
  const value = String(href || '').toLowerCase();
  if (!value) return false;
  return isPostPermalink(value) || isPhotoPageUrl(value) || isCommentOrReplyUrl(value);
}

function scoreAuthorAnchor(link, index, anchorEl) {
  if (!link || link === anchorEl) return -Infinity;
  const href = link.getAttribute('href') || '';
  const text = cleanAuthorText(link.innerText || link.textContent || '');
  if (!text || isJunkText(text) || text.length > 120) return -Infinity;
  if (isLikelyPermalinkHref(href)) return -Infinity;

  let score = 0;
  const lowerHref = href.toLowerCase();
  const lowerText = text.toLowerCase();

  // روابط الحسابات/الصفحات المعتادة.
  if (/\/profile\.php(?:\?|$)/i.test(lowerHref)) score += 100;
  if (/\/pages\//i.test(lowerHref)) score += 90;
  if (/facebook\.com\/[^/?#]+(?:\/)?(?:$|[?#])/i.test(lowerHref)) score += 80;
  if (link.closest('header')) score += 30;
  if (link.querySelector('img')) score += 15; // غالبًا صورة الحساب داخل رابط الاسم.
  if (text.length <= 80) score += 10;

  // الأسماء تكون غالبًا ضمن أول مجموعة روابط في رأس المنشور؛ نكافئ الموضع المبكر.
  score += Math.max(0, 20 - index);

  // استبعد بعض أزرار الواجهة الشائعة التي قد تحمل نصًا قصيرًا فقط.
  if (/^(follow|متابعة|more|المزيد|share|مشاركة|comment|تعليق|like|إعجاب)$/i.test(lowerText)) score -= 100;
  return score;
}

function extractAuthor(postEl, anchorEl) {
  const allLinks = Array.from(postEl.querySelectorAll('a[href]'));

  // الاستراتيجية الأساسية: تقييم كل الروابط بدل الاعتماد على نطاق 4 آباء فقط،
  // لأن بنية Facebook تتغير من نوع منشور لآخر ومن الحساب الشخصي للصفحات والمجموعات.
  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < allLinks.length; index += 1) {
    const link = allLinks[index];
    const score = scoreAuthorAnchor(link, index, anchorEl);
    if (score > bestScore) {
      bestScore = score;
      best = link;
    }
  }

  if (best && bestScore > 25) return cleanAuthorText(best.innerText || best.textContent || '');

  // fallback: ابحث في نطاق الرأس القريب من رابط الوقت.
  const scope = anchorEl ? nearbyScope(anchorEl, postEl, 7) : postEl;
  for (const link of scope.querySelectorAll('a[href]')) {
    const text = cleanAuthorText(link.innerText || link.textContent || '');
    const href = link.getAttribute('href') || '';
    if (!text || link === anchorEl || isJunkText(text) || text.length > 120 || isLikelyPermalinkHref(href)) continue;
    if (text.length <= 80) return text;
  }

  return '';
}

function extractPostText(postEl) {
  for (const selector of SELECTORS.message) {
    const el = postEl.querySelector(selector);
    const text = el?.innerText?.trim();
    if (text) return text;
  }

  const clone = postEl.cloneNode(true);
  clone.querySelectorAll('ul, [role="button"], [aria-label*="تعليق"], [aria-label*="Comment"], [aria-label*="share"], [aria-label*="مشاركة"]').forEach((el) => el.remove());

  const candidates = Array.from(clone.querySelectorAll('[dir="auto"]'))
    .map((el) => (el.innerText || '').trim())
    .filter((text) => text && !isJunkText(text) && text.length <= 20000);

  const unique = [...new Set(candidates)];
  const topLevel = unique.filter((text, index) => !unique.some((other, otherIndex) => otherIndex !== index && other.length > text.length && other.includes(text)));
  return topLevel.join('\n').trim();
}

function isReactionOrIconImage(url, altOrLabel) {
  try {
    const u = new URL(url, location.origin);
    if (u.hostname.startsWith('static.') || u.pathname.includes('rsrc.php') || u.pathname.includes('emoji.php')) return true;
  } catch {
    // ignore
  }

  const label = String(altOrLabel || '').toLowerCase().trim();
  return SELECTORS.reactionHints.some((hint) => label.includes(hint.toLowerCase()));
}

function getBestImageUrl(img) {
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
  if (srcset) {
    const candidates = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/))
      .map(([url, descriptor]) => {
        const normalizedUrl = String(url || '').trim();
        const descriptorValue = String(descriptor || '').trim();
        const width = /^(\d+)w$/i.test(descriptorValue) ? Number.parseInt(descriptorValue, 10) : 0;
        const density = /^(\d+(?:\.\d+)?)x$/i.test(descriptorValue) ? Number(descriptorValue) : 0;
        const densityScore = density ? (img.naturalWidth || img.width || 0) * density : 0;
        return {
          url: normalizedUrl,
          score: width || densityScore
        };
      })
      .filter((item) => item.url);

    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0]?.url) return candidates[0].url;
  }

  return (
    img.getAttribute('data-original') ||
    img.getAttribute('data-image-url') ||
    img.getAttribute('data-src') ||
    img.currentSrc ||
    img.src ||
    ''
  );
}

function findPhotoPageUrl(img, postEl) {
  // Facebook قد يضع رابط الصورة الحقيقي على الأب أو على data-imgpermalink.
  let current = img;
  for (let level = 0; current && level < 6; level += 1, current = current.parentElement) {
    const directCandidates = [
      getAttributeUrl(current, ['data-imgpermalink', 'data-permalink', 'data-href', 'data-uri', 'ajaxify']),
      current.matches?.('a[href]') ? current.getAttribute('href') : ''
    ].filter(Boolean);

    for (const raw of directCandidates) {
      const absolute = getAbsoluteUrl(raw);
      if (isPhotoPageUrl(absolute)) return canonicalizeFacebookUrl(absolute);
    }

    const anchors = current.querySelectorAll?.('a[href]') || [];
    for (const anchor of anchors) {
      const absolute = getAbsoluteUrl(anchor.getAttribute('href'));
      if (isPhotoPageUrl(absolute)) return canonicalizeFacebookUrl(absolute);
    }
  }

  // أحيانًا رابط الصورة موجود في نفس article عبر attribute.
  for (const el of postEl.querySelectorAll('[data-imgpermalink], [data-permalink], [data-href]')) {
    const raw = getElementUrl(el);
    const absolute = getAbsoluteUrl(raw);
    if (isPhotoPageUrl(absolute)) return canonicalizeFacebookUrl(absolute);
  }
  return '';
}

function extractImageUrls(postEl) {
  const pageUrls = [];
  const directUrls = [];
  const seenPage = new Set();
  const seenDirect = new Set();

  const addPair = (pageUrl, directUrl, label = '') => {
    const page = pageUrl ? canonicalizeFacebookUrl(getAbsoluteUrl(pageUrl)) : '';
    const direct = getAbsoluteUrl(directUrl);
    if (page && !seenPage.has(page) && !isReactionOrIconImage(page, label)) {
      seenPage.add(page);
      pageUrls.push(page);
      directUrls.push(direct || '');
      return;
    }
    if (direct && !seenDirect.has(direct) && !isReactionOrIconImage(direct, label)) {
      seenDirect.add(direct);
      pageUrls.push(direct);
      directUrls.push(direct);
    }
  };

  for (const img of postEl.querySelectorAll('img')) {
    const alt = img.getAttribute('alt') || img.getAttribute('aria-label') || '';
    const isAvatar = SELECTORS.avatarHints.some((hint) => alt.toLowerCase().includes(hint.toLowerCase()));
    if (isAvatar) continue;

    const width = img.naturalWidth || Number(img.getAttribute('width')) || 0;
    const height = img.naturalHeight || Number(img.getAttribute('height')) || 0;
    if (width && height && (width < 80 || height < 80)) continue;

    const direct = getBestImageUrl(img);
    const page = findPhotoPageUrl(img, postEl);
    addPair(page, direct, alt);
  }

  for (const el of postEl.querySelectorAll('div[role="img"], div[style*="background-image"]')) {
    const style = el.getAttribute('style') || '';
    const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    if (match) addPair(findPhotoPageUrl(el, postEl), match[2], el.getAttribute('aria-label') || '');
  }

  return { urls: pageUrls.filter(Boolean), directUrls };
}

function isLikelyVideoUrl(href) {
  return SELECTORS.videoHints.some((hint) => href.includes(hint)) || /[?&]v=\d+/i.test(href);
}

function extractVideoUrls(postEl, postUrl) {
  let pageUrl = '';
  for (const link of postEl.querySelectorAll('a[href]')) {
    const href = getAbsoluteUrl(link.getAttribute('href') || '');
    if (href && isLikelyVideoUrl(href)) {
      pageUrl = canonicalizeFacebookUrl(href);
      break;
    }
  }

  if (!pageUrl && isLikelyVideoUrl(postUrl)) {
    pageUrl = canonicalizeFacebookUrl(postUrl);
  }

  let directUrl = '';
  const video = postEl.querySelector('video');
  if (video) {
    const candidates = [
      video.getAttribute('src'),
      video.getAttribute('data-src'),
      video.getAttribute('data-video-url'),
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll('source[src]')).map((source) => source.getAttribute('src'))
    ]
      .map((url) => getAbsoluteUrl(url || ''))
      .filter(Boolean);

    const unique = [...new Set(candidates)];
    const scoreVideoUrl = (url) => {
      const value = String(url || '').toLowerCase();
      const quality = value.match(/(?:^|[^0-9])(2160|1440|1080|720|480|360)(?:p|[^0-9]|$)/);
      const width = value.match(/(?:width|w|res)[=_-]?(\d{3,4})/i);
      const height = value.match(/(?:height|h)[=_-]?(\d{3,4})/i);
      return (quality ? Number(quality[1]) : 0)
        + (width ? Number(width[1]) * 0.1 : 0)
        + (height ? Number(height[1]) * 0.15 : 0);
    };

    unique.sort((a, b) => scoreVideoUrl(b) - scoreVideoUrl(a));
    directUrl = unique[0] || '';
  }

  return { pageUrl, directUrl };
}

// Backward-compatible helper for code paths that only need the Facebook video page URL.
function extractVideoUrl(postEl, postUrl) {
  return extractVideoUrls(postEl, postUrl).pageUrl;
}

function extractStableFacebookId(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value, location.origin);
    const params = url.searchParams;
    for (const key of ['story_fbid', 'fbid', 'v']) {
      const candidate = String(params.get(key) || '').trim();
      if (/^[0-9]{6,}$/.test(candidate) || /^pfbid[A-Za-z0-9]+$/i.test(candidate)) return candidate;
    }
    const pathMatch = url.pathname.match(/(pfbid[A-Za-z0-9]+)/i);
    if (pathMatch?.[1]) return pathMatch[1];
    const patterns = [
      /\/posts\/(\d+)/i,
      /\/permalink\/(\d+)/i,
      /\/reel\/(\d+)/i,
      /\/videos?\/(\d+)/i,
      /\/photos\/[^/]+\/(\d+)/i
    ];
    for (const pattern of patterns) {
      const match = url.pathname.match(pattern);
      if (match?.[1]) return match[1];
    }
  } catch {
    // ignore malformed URL
  }
  return '';
}

function identityNormalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildLightPostFingerprint(author, text) {
  return `ft:${simpleHash([identityNormalize(author), identityNormalize(text)].join('\u241f'))}`;
}

function buildPostFingerprint(author, text, images, videoUrl) {
  const parts = [
    identityNormalize(author),
    identityNormalize(text),
    ...(images?.urls || []).map(identityNormalize),
    ...(images?.directUrls || []).map(identityNormalize),
    identityNormalize(videoUrl)
  ];
  return `fp:${simpleHash(parts.join('\u241f'))}`;
}

function buildPostIdentityCandidates(postEl, postUrl, author, text, images, videoUrl, dateTimeRaw) {
  const keys = new Set();
  const normalizedUrl = postUrl ? canonicalizeFacebookUrl(getAbsoluteUrl(postUrl)) : '';
  const stableId = extractStableFacebookId(normalizedUrl);
  if (stableId) keys.add(`fb:${stableId}`);
  if (normalizedUrl) keys.add(`url:${normalizedUrl}`);
  if (normalizedUrl) keys.add(normalizedUrl);
  keys.add(buildLightPostFingerprint(author, text));
  const fingerprint = buildPostFingerprint(author, text, images, videoUrl);
  keys.add(fingerprint);

  // Backward compatibility with the pre-v2.6 hash format.
  keys.add(`hash-${simpleHash(`${text.slice(0, 500)}|${dateTimeRaw || ''}`)}`);
  return [...keys];
}

function buildPostId(postUrl, author, text, images, videoUrl, dateTimeRaw) {
  const normalizedUrl = postUrl ? canonicalizeFacebookUrl(getAbsoluteUrl(postUrl)) : '';
  const stableId = extractStableFacebookId(normalizedUrl);
  if (stableId) return `fb:${stableId}`;
  if (normalizedUrl) return `url:${normalizedUrl}`;
  return buildPostFingerprint(author, text, images, videoUrl) || `hash-${simpleHash(`${text.slice(0, 500)}|${dateTimeRaw || ''}`)}`;
}

function createButton(postEl) {
  const wrapper = document.createElement('div');
  wrapper.className = 'fps-btn-wrapper';

  const button = document.createElement('button');
  button.className = 'fps-save-btn';
  button.type = 'button';
  button.textContent = '📥 حفظ';
  button.dataset.state = 'idle';

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleSaveClick(postEl, button);
  });

  wrapper.appendChild(button);

  if (getComputedStyle(postEl).position === 'static') postEl.style.position = 'relative';
  postEl.appendChild(wrapper);
  return button;
}

function updateButtonState(button, candidateKeys) {
  const keys = Array.isArray(candidateKeys) ? candidateKeys.filter(Boolean) : [];
  const isSaved = keys.some((key) => savedPostIds.has(key));

  if (isSaved) {
    button.innerHTML = '<span class="fps-check-icon" aria-hidden="true">✓</span> تم الحفظ';
    button.dataset.state = 'saved';
    button.disabled = false;
    button.title = 'هذا المنشور محفوظ بالفعل — اضغط لتحديث بياناته';
    button.dataset.postKeys = JSON.stringify(keys);
    return;
  }

  if (button.dataset.state !== 'saving') {
    button.innerHTML = '<span aria-hidden="true">📥</span> حفظ';
    button.dataset.state = 'idle';
    button.disabled = false;
    button.title = 'حفظ هذا المنشور';
  }
  button.dataset.postKeys = JSON.stringify(keys);
}

function getPostIdentitySnapshot(postEl) {
  const postUrl = extractPermalink(postEl);
  const text = extractPostText(postEl);
  const dateTime = resolveDateTime(postEl, findPermalinkAnchor(postEl));
  const author = extractAuthor(postEl, findPermalinkAnchor(postEl));
  const images = extractImageUrls(postEl);
  const videoUrl = extractVideoUrl(postEl, postUrl);
  return { postUrl, text, dateTime, author, images, videoUrl };
}

function ensureButton(postEl) {
  const existing = postEl.querySelector(':scope > .fps-btn-wrapper .fps-save-btn');
  const button = existing || createButton(postEl);
  const postUrl = extractPermalink(postEl);
  const author = extractAuthor(postEl, findPermalinkAnchor(postEl));
  const text = extractPostText(postEl);
  const keys = new Set();
  const normalizedUrl = postUrl ? canonicalizeFacebookUrl(getAbsoluteUrl(postUrl)) : '';
  const stableId = extractStableFacebookId(normalizedUrl);
  if (stableId) keys.add(`fb:${stableId}`);
  if (normalizedUrl) { keys.add(`url:${normalizedUrl}`); keys.add(normalizedUrl); }
  keys.add(buildLightPostFingerprint(author, text));
  updateButtonState(button, [...keys]);
}


async function resolveDateTimeWithRetry(postEl, anchorEl, attempts = 6) {
  let freshPermalink = findPermalinkAnchor(postEl);
  let temporalAnchor = findBestTimestampAnchor(postEl, freshPermalink || anchorEl);
  let result = resolveDateTime(postEl, temporalAnchor || freshPermalink || anchorEl);

  if (result.date && result.time) return result;

  // اطلب tooltip الدقيق من رابط timestamp نفسه بدل احتساب الوقت من لحظة الحفظ.
  if (temporalAnchor) {
    const exactFromHover = await readExactTimestampAfterHover(postEl, temporalAnchor, 900);
    if (exactFromHover?.date && exactFromHover?.time) return exactFromHover;
  }

  for (let i = 1; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250 * i));
    freshPermalink = findPermalinkAnchor(postEl);
    temporalAnchor = findBestTimestampAnchor(postEl, freshPermalink || anchorEl);
    result = resolveDateTime(postEl, temporalAnchor || freshPermalink || anchorEl);
    if (result.date && result.time) return result;

    if (temporalAnchor) {
      const exactFromHover = await readExactTimestampAfterHover(postEl, temporalAnchor, 500);
      if (exactFromHover?.date && exactFromHover?.time) return exactFromHover;
    }
  }

  return { date: '', time: '', raw: '' };
}

async function handleSaveClick(postEl, button) {
  if (button.dataset.state === 'saving') return;

  button.dataset.state = 'saving';
  button.disabled = true;
  button.innerHTML = '<span aria-hidden="true">⏳</span> جاري الحفظ...';

  try {
    const postUrl = extractPermalink(postEl);
    const text = extractPostText(postEl);
    const permalinkAnchor = findPermalinkAnchor(postEl);
    const dateTime = await resolveDateTimeWithRetry(postEl, findBestTimestampAnchor(postEl, permalinkAnchor), 6);
    const author = extractAuthor(postEl, findPermalinkAnchor(postEl));
    const images = extractImageUrls(postEl);
    const video = extractVideoUrls(postEl, postUrl);
    const videoUrl = video.pageUrl;
    const postId = buildPostId(postUrl, author, text, images, videoUrl, dateTime.raw);
    const identityKeys = buildPostIdentityCandidates(postEl, postUrl, author, text, images, videoUrl, dateTime.raw);

    const row = {
      id: postId,
      identityKey: postId,
      fingerprint: buildPostFingerprint(author, text, images, videoUrl),
      author,
      date: dateTime.date,
      time: dateTime.time,
      privacy: extractPrivacy(postEl, findPermalinkAnchor(postEl)),
      text,
      imageUrls: images.urls,
      imageDirectUrls: images.directUrls,
      videoUrl,
      videoDirectUrl: video.directUrl,
      postUrl,
      savedAt: new Date().toISOString()
    };

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_POST', payload: row });
    if (!response?.ok) throw new Error(response?.error || 'فشل حفظ المنشور');

    for (const key of [...identityKeys, ...(response.keys || []), postId]) savedPostIds.add(key);
    updateButtonState(button, [...identityKeys, ...(response.keys || []), postId]);
  } catch (error) {
    console.error('[Facebook Post Saver] save error:', error);
    button.textContent = '⚠ خطأ';
    button.dataset.state = 'error';
    button.disabled = false;
    setTimeout(() => {
      if (button.dataset.state === 'error') {
        button.innerHTML = '<span aria-hidden="true">📥</span> حفظ';
        button.dataset.state = 'idle';
      }
    }, 2500);
  }
}

function processPost(postEl) {
  if (!(postEl instanceof Element) || !isPrimaryPostElement(postEl)) return;
  ensureButton(postEl);
}

function queuePost(postEl) {
  if (!postEl) return;
  queuedPostElements.add(postEl);
}

function flushQueuedPosts() {
  scanTimer = null;
  const items = Array.from(queuedPostElements);
  queuedPostElements.clear();
  for (const post of items) processPost(post);
}

function schedulePostScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(flushQueuedPosts, 180);
}

function initialScan() {
  document.querySelectorAll(SELECTORS.post).forEach((post) => {
    if (isPrimaryPostElement(post)) queuePost(post);
  });
  schedulePostScan();
}

const observer = new MutationObserver((mutations) => {
  let changed = false;

  for (const mutation of mutations) {
    const targetArticle = mutation.target?.closest?.(SELECTORS.post);
    if (targetArticle) {
      queuePost(targetArticle);
      changed = true;
    }

    for (const node of mutation.addedNodes || []) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.(SELECTORS.post) && isPrimaryPostElement(node)) queuePost(node);
      node.querySelectorAll?.(SELECTORS.post).forEach((post) => { if (isPrimaryPostElement(post)) queuePost(post); });
      const parentArticle = node.closest?.(SELECTORS.post);
      if (parentArticle && isPrimaryPostElement(parentArticle)) queuePost(parentArticle);
      changed = true;
    }
  }

  if (changed) schedulePostScan();
});

observer.observe(document.body, { childList: true, subtree: true });

// أظهر الأزرار فورًا، ثم حدّث حالات «تم الحفظ» بعد وصول الفهرس من IndexedDB.
initialScan();

chrome.runtime.sendMessage({ type: 'GET_SAVED_IDS' })
  .then((response) => {
    if (response?.ok) {
      savedPostIds = new Set(Array.isArray(response.keys) ? response.keys : response.ids || []);
      document.querySelectorAll(SELECTORS.post).forEach((post) => { if (isPrimaryPostElement(post)) processPost(post); });
    }
  })
  .catch((error) => console.warn('[Facebook Post Saver] تعذر تحميل حالة المنشورات المحفوظة:', error));

// مزامنة حالة زر الحفظ لحظيًا بين تبويبات Facebook المفتوحة.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'POST_SAVED_EXTERNALLY') {
    for (const key of (Array.isArray(message.keys) ? message.keys : [])) {
      if (key) savedPostIds.add(String(key));
    }
    document.querySelectorAll(SELECTORS.post).forEach((post) => { if (isPrimaryPostElement(post)) queuePost(post); });
    schedulePostScan();
  }

  if (message?.type === 'POST_DELETED_EXTERNALLY') {
    for (const key of (Array.isArray(message.keys) ? message.keys : [])) {
      savedPostIds.delete(String(key));
    }
    document.querySelectorAll(SELECTORS.post).forEach((post) => { if (isPrimaryPostElement(post)) queuePost(post); });
    schedulePostScan();
  }
});

window.addEventListener('pageshow', () => {
  initialScan();
});
window.addEventListener('popstate', () => {
  setTimeout(initialScan, 120);
});
window.addEventListener('hashchange', () => {
  setTimeout(initialScan, 120);
});
