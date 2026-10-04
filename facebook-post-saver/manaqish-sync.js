// =====================================================================
//  Facebook Post Saver — مزامنة «مناقيش»
//
//  يُحمَّل داخل Service Worker عبر importScripts.
//
//  ⚠️ اتجاه واحد فقط: من هذا الجهاز إلى النظام.
//
//  الإضافة ترفع المنشورات المحفوظة، ولا تنزّل أي شيء أبدًا. التعديل
//  والترجمة والمراجعة كلها تحدث داخل نظام مناقيش، والنظام هو المصدر
//  الوحيد للحقيقة في المحتوى.
//
//  لماذا لا توجد مزامنة عكسية؟
//  ----------------------------
//  لأن كتابة قيم الإضافة فوق صف موجود على السيرفر تُفسد بيانات لا
//  تملكها الإضافة. وأوضح مثال: عمود `saved_at`. المنشورات القديمة
//  المحفوظة محليًا بلا `savedAt` تأخذ وقت الإرسال الحالي كقيمة
//  احتياطية، فإعادة إرسال الأرشيف كله تختم كل المنشورات القديمة بنفس
//  اللحظة. مع `resolution=ignore-duplicates` لا يحدث ذلك إطلاقًا: كل
//  منشور يُكتب مرة واحدة عند حفظه، وما بعده يُتجاهل.
//
//  ولذلك: احفظ منشورًا جديدًا فيُرسل مرة واحدة، وهذا كل شيء.
// =====================================================================

const MQ_SESSION_KEY = 'manaqishSession';
const MQ_QUEUE_KEY = 'manaqishQueue';
const MQ_STATUS_KEY = 'manaqishStatus';
const MQ_BATCH = 100;

async function mqGet(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] ?? fallback;
}
async function mqSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function mqSetStatus(patch) {
  const current = await mqGet(MQ_STATUS_KEY, {});
  await mqSet(MQ_STATUS_KEY, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

async function mqRefresh(session) {
  const res = await fetch(`${MANAQISH_CONFIG.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: MANAQISH_CONFIG.publishableKey },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      await chrome.storage.local.remove(MQ_SESSION_KEY);
      await mqSetStatus({ state: 'signed_out', message: 'انتهت الجلسة، سجّل الدخول مرة أخرى.' });
    }
    throw new Error('تعذر تجديد الجلسة');
  }
  const data = await res.json();
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email || session.email
  };
  await mqSet(MQ_SESSION_KEY, next);
  return next;
}

async function mqToken(force = false) {
  let session = await mqGet(MQ_SESSION_KEY, null);
  if (!session?.refresh_token) return null;
  if (force || !session.expires_at || session.expires_at * 1000 - Date.now() < 60_000) {
    session = await mqRefresh(session);
  }
  return session.access_token;
}

function mqToRecord(row) {
  return {
    post_key: String(row.id),
    author: row.author || '',
    post_date: row.date || '',
    post_time: row.time || '',
    privacy: row.privacy || 'unknown',
    text: row.text || '',
    markdown_text: row.markdownText || '',
    image_urls: row.imageUrls || [],
    image_direct_urls: row.imageDirectUrls || [],
    video_url: row.videoUrl || '',
    video_direct_url: row.videoDirectUrl || '',
    post_url: row.postUrl || '',
    saved_at: row.savedAt || new Date().toISOString()
  };
}

async function mqEnqueue(items) {
  const queue = await mqGet(MQ_QUEUE_KEY, []);
  const keyed = new Map(queue.map((q) => [`${q.op}:${q.key}`, q]));
  for (const item of items) {
    // حذف لاحق يلغي إرسالًا معلقًا لنفس المنشور والعكس.
    keyed.delete(`${item.op === 'upsert' ? 'delete' : 'upsert'}:${item.key}`);
    keyed.set(`${item.op}:${item.key}`, item);
  }
  await mqSet(MQ_QUEUE_KEY, [...keyed.values()]);
  mqFlush().catch(() => {});
}

function manaqishQueueUpsert(row, isRevision = false) {
  if (!row?.id) return;
  // `rev` marks a re-save of a post that already exists on this device, so
  // the server refreshes its content instead of ignoring it.
  mqEnqueue([{ op: 'upsert', key: String(row.id), rev: Boolean(isRevision), record: mqToRecord(row) }]).catch(() => {});
}

/**
 * The fields a re-save is allowed to update on an existing server row.
 *
 * Deliberately EXCLUDES `post_date`, `post_time` and `saved_at`.
 * A re-save carries whatever date Facebook exposed at that moment, and if
 * the extraction comes back empty it would erase a previously captured
 * date. The captured time is history: it is write-once, at first save.
 */
function mqRevisionBody(record) {
  return {
    author: record.author,
    privacy: record.privacy,
    text: record.text,
    markdown_text: record.markdown_text,
    image_urls: record.image_urls,
    image_direct_urls: record.image_direct_urls,
    video_url: record.video_url,
    video_direct_url: record.video_direct_url,
    post_url: record.post_url
  };
}

/** Updates the content of one already-existing row. */
async function mqPatchPost(postKey, record) {
  const res = await mqRequest(`posts?post_key=eq.${encodeURIComponent(postKey)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(mqRevisionBody(record))
  });
  // 401 is retried once inside mqRequest already.
  return res.ok;
}

function manaqishQueueDelete(postId) {
  if (!postId) return;
  mqEnqueue([{ op: 'delete', key: String(postId) }]).catch(() => {});
}

async function mqRequest(path, init, retry = true) {
  const token = await mqToken();
  if (!token) throw Object.assign(new Error('not signed in'), { code: 'signed_out' });
  const res = await fetch(`${MANAQISH_CONFIG.apiUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: MANAQISH_CONFIG.publishableKey,
      Authorization: `Bearer ${token}`,
      ...(init.headers || {})
    }
  });
  if (res.status === 401 && retry) {
    await mqToken(true);
    return mqRequest(path, init, false);
  }
  return res;
}

let mqFlushing = null;
function mqFlush() {
  if (!mqFlushing) {
    mqFlushing = mqDoFlush().finally(() => { mqFlushing = null; });
  }
  return mqFlushing;
}

async function mqDoFlush() {
  const session = await mqGet(MQ_SESSION_KEY, null);
  if (!session) return;
  let queue = await mqGet(MQ_QUEUE_KEY, []);

  while (queue.length) {
    const pending = queue.filter((q) => q.op === 'upsert').slice(0, MQ_BATCH);
    // A post saved for the FIRST time is inserted. A post that already
    // existed on this device is a re-save, so its content is refreshed.
    const inserts = pending.filter((q) => !q.rev);
    const revisions = pending.filter((q) => q.rev);
    const deletes = queue.filter((q) => q.op === 'delete').slice(0, MQ_BATCH);

    try {
      if (inserts.length) {
        const res = await mqRequest('posts?on_conflict=user_id,post_key', {
          method: 'POST',
          // ignore-duplicates = ON CONFLICT DO NOTHING.
          //
          // Keeps the guarantee that a given post is inserted exactly once,
          // so re-sending an archive cannot overwrite `saved_at` — which has
          // a "now" fallback for rows with no stored time and would
          // otherwise stamp every old post with the same moment.
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(inserts.map((u) => u.record))
        });

        if (res.status === 403 || res.status === 401) {
          await mqSetStatus({ state: 'denied', message: 'حسابك غير مسموح. تواصل مع المدير.' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }

      // Re-saves refresh content only; the captured date is never touched.
      for (const item of revisions) {
        await mqPatchPost(item.key, item.record);
      }

      for (const d of deletes) {
        const res = await mqRequest(`posts?post_key=eq.${encodeURIComponent(d.key)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      await mqSetStatus({ state: 'offline', message: 'تعذر الاتصال؛ ستُرسل المنشورات لاحقًا تلقائيًا.' });
      return;
    }

    const done = new Set([...pending, ...deletes].map((q) => `${q.op}:${q.key}`));
    queue = (await mqGet(MQ_QUEUE_KEY, [])).filter((q) => !done.has(`${q.op}:${q.key}`));
    await mqSet(MQ_QUEUE_KEY, queue);
  }

  await mqSetStatus({ state: 'synced', message: '', lastSyncAt: new Date().toISOString() });
}

async function manaqishHandleMessage(message) {
  switch (message.type) {
    case 'MANAQISH_SET_SESSION': {
      const s = message.session || {};
      if (!s.refresh_token || !s.access_token) throw new Error('جلسة غير صالحة');
      await mqSet(MQ_SESSION_KEY, {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        email: s.email || ''
      });
      await mqSetStatus({ state: 'synced', message: '' });
      mqFlush().catch(() => {});
      return { ok: true };
    }

    case 'MANAQISH_STATUS': {
      const [session, queue, status] = await Promise.all([
        mqGet(MQ_SESSION_KEY, null),
        mqGet(MQ_QUEUE_KEY, []),
        mqGet(MQ_STATUS_KEY, {})
      ]);
      return {
        ok: true,
        signedIn: !!session,
        email: session?.email || '',
        pending: queue.length,
        status,
        siteUrl: MANAQISH_CONFIG.siteUrl
      };
    }

    case 'MANAQISH_SIGN_OUT': {
      await chrome.storage.local.remove([MQ_SESSION_KEY, MQ_STATUS_KEY]);
      return { ok: true };
    }

    case 'MANAQISH_SYNC_ALL': {
      // "Send my old posts": useful once, right after signing in, to get
      // an existing local archive into مناقيش. Already-sent posts are
      // ignored by the server, so running it again is harmless.
      const rows = await getAllPosts();
      await mqEnqueue(rows.map((row) => ({ op: 'upsert', key: String(row.id), record: mqToRecord(row) })));
      await mqFlush();
      return { ok: true, queued: rows.length };
    }

    case 'MANAQISH_FLUSH': {
      await mqFlush();
      return { ok: true };
    }

    default:
      return { ok: false, error: 'رسالة غير معروفة.' };
  }
}

chrome.alarms?.create('manaqish-flush', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'manaqish-flush') mqFlush().catch(() => {});
});
mqFlush().catch(() => {});
