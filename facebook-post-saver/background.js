// Facebook Post Saver v2.12 — Service Worker
// المصدر الدائم للبيانات: IndexedDB داخل أصل الإضافة.
// chrome.storage.local يُستخدم فقط لبيانات الإصدارات القديمة أثناء الترحيل.

importScripts('manaqish-config.js', 'manaqish-sync.js');

const DB_NAME = 'facebookPostSaverDB';
const DB_VERSION = 1;
const STORE_NAME = 'posts';
const LEGACY_KEYS = ['postsTable', 'savedPostIds', 'nextPostNumber'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح قاعدة البيانات'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('فشل طلب IndexedDB'));
  });
}

function canonicalPostId(value) {
  const id = String(value || '').trim();
  return id || null;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeIdentityPart(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function simpleHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function extractStableFacebookId(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const params = url.searchParams;
    for (const key of ['story_fbid', 'fbid', 'v']) {
      const candidate = String(params.get(key) || '').trim();
      if (/^[0-9]{6,}$/.test(candidate) || /^pfbid[A-Za-z0-9]+$/i.test(candidate)) return candidate;
    }
    const pathMatch = url.pathname.match(/(pfbid[A-Za-z0-9]+)/i);
    if (pathMatch?.[1]) return pathMatch[1];

    const pathPatterns = [
      /\/posts\/(\d+)/i,
      /\/permalink\/(\d+)/i,
      /\/reel\/(\d+)/i,
      /\/videos?\/(\d+)/i,
      /\/photos\/[^/]+\/(\d+)/i
    ];
    for (const pattern of pathPatterns) {
      const match = url.pathname.match(pattern);
      if (match?.[1]) return match[1];
    }
  } catch {
    // ignore malformed URL
  }
  return '';
}

function lightPostFingerprint(row) {
  const parts = [normalizeIdentityPart(row.author), normalizeIdentityPart(row.text)];
  return `ft:${simpleHash(parts.join('\u241f'))}`;
}

function postFingerprint(row) {
  const parts = [
    normalizeIdentityPart(row.author),
    normalizeIdentityPart(row.text),
    ...(row.imageUrls || []).map(normalizeIdentityPart),
    ...(row.imageDirectUrls || []).map(normalizeIdentityPart),
    normalizeIdentityPart(row.videoUrl)
  ];
  return `fp:${simpleHash(parts.join('\u241f'))}`;
}

function buildIdentityKey(row) {
  const stableId = extractStableFacebookId(row.postUrl);
  if (stableId) return `fb:${stableId}`;
  const postUrl = String(row.postUrl || '').trim();
  if (postUrl) return `url:${postUrl}`;
  return postFingerprint(row);
}

function buildRowAliases(row) {
  const aliases = new Set();
  const candidates = [
    row.id,
    row.postUrl,
    row.identityKey,
    row.fingerprint,
    buildIdentityKey(row),
    postFingerprint(row),
    lightPostFingerprint(row)
  ];
  for (const value of candidates) {
    const normalized = String(value || '').trim();
    if (normalized) aliases.add(normalized);
  }
  return [...aliases];
}

function normalizeRow(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const id = canonicalPostId(row.id || row.post_url);
  if (!id) return null;

  return {
    id,
    author: String(row.author || row.account || '').trim() || 'غير معروف',
    date: String(row.date || '').trim(),
    time: String(row.time || '').trim(),
    privacy: ['public', 'friends', 'private'].includes(row.privacy) ? row.privacy : 'unknown',
    text: String(row.text || '').trim(),
    markdownText: String(row.markdownText ?? '').trim(),
    imageUrls: normalizeArray(row.imageUrls ?? row.images ?? row.image_urls),
    imageDirectUrls: normalizeArray(row.imageDirectUrls ?? row.image_direct_urls),
    videoUrl: String(row.videoUrl ?? row.video_url ?? '').trim(),
    videoDirectUrl: String(row.videoDirectUrl ?? row.video_direct_url ?? '').trim(),
    postUrl: String(row.postUrl ?? row.post_url ?? '').trim(),
    identityKey: String(row.identityKey || '').trim() || null,
    fingerprint: String(row.fingerprint || '').trim() || null,
    savedAt: String(row.savedAt || new Date().toISOString()),
    exported: row.exported === true,
    exportedAt: String(row.exportedAt || '').trim(),
    exportFileName: String(row.exportFileName || '').trim()
  };
}


async function getAllPosts() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const rows = await idbRequest(store.getAll());
  return rows || [];
}

async function getAllPostIds() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const ids = await idbRequest(store.getAllKeys());
  return (ids || []).map(String);
}

async function putPost(row) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let existed = false;
    let requestError = null;

    const existedRequest = store.get(row.id);
    existedRequest.onsuccess = () => {
      const existingRow = existedRequest.result;
      existed = Boolean(existingRow);

      // حالة «مُصدّر» تعني أن هذا السجل سبق تصديره، لذلك لا نفقد العلامة
      // عندما يعاد حفظ/تحديث المنشور من Facebook لاحقًا.
      if (existingRow?.exported === true && row.exported !== true) {
        row.exported = true;
        row.exportedAt = String(existingRow.exportedAt || '').trim();
        row.exportFileName = String(existingRow.exportFileName || '').trim();
      }

      const request = store.put(row);
      request.onerror = () => {
        requestError = request.error || new Error('فشل حفظ المنشور');
        tx.abort();
      };
    };
    existedRequest.onerror = () => {
      requestError = existedRequest.error || new Error('فشل التحقق من المنشور الموجود');
      tx.abort();
    };

    tx.oncomplete = () => resolve({ added: !existed, updated: existed });
    tx.onabort = () => reject(requestError || tx.error || new Error('فشل معاملة حفظ المنشور'));
  });
}

async function updatePostMarkdown(id, markdownText) {
  const postId = String(id || '').trim();
  if (!postId) throw new Error('معرّف المنشور غير صالح.');

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(postId);

    request.onsuccess = () => {
      const row = request.result;
      if (!row) {
        tx.abort();
        reject(new Error('المنشور غير موجود.'));
        return;
      }
      row.markdownText = String(markdownText || '').trim();
      store.put(row);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve({ updated: 1 });
    tx.onabort = () => reject(tx.error || new Error('فشل حفظ Markdown'));
  });
}

async function markPostsExported(ids, exportFileName) {
  const targetIds = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean));
  if (!targetIds.size) return { updated: 0 };

  const db = await openDb();
  const now = new Date().toISOString();
  let updated = 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => resolve({ updated });
    tx.onerror = () => reject(tx.error || new Error('فشل تحديث حالة التصدير'));

    for (const id of targetIds) {
      const request = store.get(id);
      request.onsuccess = () => {
        const row = request.result;
        if (!row) return;
        row.exported = true;
        row.exportedAt = now;
        row.exportFileName = String(exportFileName || '').trim();
        const putRequest = store.put(row);
        putRequest.onsuccess = () => { updated += 1; };
        putRequest.onerror = () => tx.abort();
      };
      request.onerror = () => tx.abort();
    }
  });
}

async function deletePost(id) {
  const postId = String(id || '').trim();
  if (!postId) throw new Error('معرّف المنشور غير صالح.');

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(postId);
    request.onerror = () => {
      try { tx.abort(); } catch {}
    };
    tx.oncomplete = () => resolve({ deleted: 1 });
    tx.onabort = () => reject(tx.error || request.error || new Error('فشل حذف المنشور'));
  });
}

function isAllowedMediaDownloadUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return /(^|\.)facebook\.com$/i.test(url.hostname)
      || /(^|\.)fbcdn\.net$/i.test(url.hostname)
      || /(^|\.)fbsbx\.com$/i.test(url.hostname)
      || /(^|\.)facebook\.net$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function sanitizeDownloadName(value, fallback = 'media') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 120);
}

function extensionFromMediaUrl(rawUrl, mediaType) {
  try {
    const pathname = decodeURIComponent(new URL(rawUrl).pathname);
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {}
  return mediaType === 'video' ? 'mp4' : 'jpg';
}

async function downloadMedia(url, filename, mediaType = 'image') {
  const rawUrl = String(url || '').trim();
  if (!rawUrl || !isAllowedMediaDownloadUrl(rawUrl)) {
    throw new Error('رابط الوسائط غير صالح أو غير مسموح بتنزيله.');
  }

  const safeBase = sanitizeDownloadName(filename, 'facebook-media');
  const extension = extensionFromMediaUrl(rawUrl, mediaType);
  const finalName = /\.[a-z0-9]{2,5}$/i.test(safeBase)
    ? safeBase
    : `${safeBase}.${extension}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: rawUrl,
      filename: finalName,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || 'تعذر بدء تنزيل الوسائط.'));
        return;
      }
      if (typeof downloadId !== 'number') {
        reject(new Error('تعذر بدء تنزيل الوسائط.'));
        return;
      }
      resolve({ downloadId, filename: finalName });
    });
  });
}

async function importPosts(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const normalizedRows = sourceRows.map(normalizeRow).filter(Boolean);
  if (!normalizedRows.length) return { added: 0, updated: 0, skipped: sourceRows.length };

  const db = await openDb();
  const existing = await getAllPosts();
  const existingIds = new Set(existing.map((row) => String(row.id || '')));
  const incoming = new Map();
  let skipped = sourceRows.length - normalizedRows.length;

  for (const row of normalizedRows) {
    // لا نكرر نفس السجل مرتين داخل ملف الاستيراد. نحتفظ بآخر نسخة في الملف.
    if (incoming.has(row.id)) skipped += 1;
    incoming.set(row.id, row);
  }

  const toAdd = [];
  const duplicates = [];
  for (const row of incoming.values()) {
    if (existingIds.has(row.id)) duplicates.push(row);
    else toAdd.push(row);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let added = 0;
    let updated = 0;

    tx.oncomplete = () => resolve({ added, updated, skipped });
    tx.onerror = () => reject(tx.error || new Error('فشل استيراد البيانات'));
    tx.onabort = () => reject(tx.error || new Error('فشل استيراد البيانات'));

    for (const row of toAdd) {
      const request = store.add(row);
      request.onsuccess = () => { added += 1; };
      request.onerror = () => { tx.abort(); };
    }

    // التكرارات تُهمل، لكن نحافظ على حالة التصدير الحالية بدل استبدال السجل
    // أو مسحها عند استيراد نسخة احتياطية قديمة.
    for (const row of duplicates) {
      skipped += 1;
    }
  });
}

async function migrateLegacyStorage() {
  const legacy = await chrome.storage.local.get(LEGACY_KEYS);
  const legacyRows = Array.isArray(legacy.postsTable) ? legacy.postsTable : [];
  if (!legacyRows.length) return;

  const normalizedRows = legacyRows.map(normalizeRow).filter(Boolean);
  if (normalizedRows.length) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('فشل ترحيل البيانات القديمة'));
      for (const row of normalizedRows) {
        const request = store.put(row);
        request.onerror = () => {
          if (request.error?.name !== 'ConstraintError') tx.abort();
        };
      }
    });
  }

  // لم يعد هناك داعٍ لتخزين النسخة الكبيرة القديمة.
  await chrome.storage.local.remove(LEGACY_KEYS);
}

let migrationPromise = null;
function ensureMigration() {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyStorage().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMigration().catch((error) => {
    console.error('[Facebook Post Saver] فشل ترحيل البيانات القديمة:', error);
  });
});

// تشغيل الترحيل أيضًا بعد إعادة تحميل الإضافة يدويًا إذا كانت النسخة القديمة موجودة.
ensureMigration().catch((error) => {
  console.error('[Facebook Post Saver] فشل فحص البيانات القديمة:', error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    await ensureMigration();

    if (String(message?.type || '').startsWith('MANAQISH_')) {
      return manaqishHandleMessage(message);
    }

    switch (message?.type) {
      case 'GET_SAVED_IDS': {
        const posts = await getAllPosts();
        const keys = new Set();
        const ids = [];
        for (const row of posts) {
          ids.push(String(row.id));
          for (const key of buildRowAliases(row)) keys.add(key);
        }
        return { ok: true, ids, keys: [...keys] };
      }

      case 'GET_ALL_POSTS':
        return { ok: true, posts: await getAllPosts() };

      case 'SAVE_POST': {
        const row = normalizeRow(message.payload);
        if (!row) throw new Error('بيانات المنشور غير صالحة.');
        row.identityKey = buildIdentityKey(row);
        row.fingerprint = postFingerprint(row);
        row.id = row.identityKey;
        const result = await putPost(row);
        // `updated` means this post was already saved on this device, so the
        // server should refresh its content too. A first-time save stays a
        // plain insert; a deleted-then-saved-again post is `added`, so it is
        // recreated normally.
        manaqishQueueUpsert(row, Boolean(result?.updated));
        const keys = buildRowAliases(row);
        // حدّث كل تبويبات Facebook المفتوحة فورًا، وليس فقط بعد Refresh.
        try {
          const tabs = await chrome.tabs.query({ url: ['*://*.facebook.com/*'] });
          for (const tab of tabs) {
            if (!tab.id || tab.id === sender?.tab?.id) continue;
            chrome.tabs.sendMessage(tab.id, { type: 'POST_SAVED_EXTERNALLY', keys, postId: row.id }).catch(() => {});
          }
        } catch (e) {
          console.debug('[Facebook Post Saver] cross-tab notify skipped:', e);
        }
        return { ok: true, ...result, row, keys };
      }

      case 'DELETE_POST': {
        const postId = String(message.id || '').trim();
        const existing = (await getAllPosts()).find((item) => String(item.id || '') === postId);
        const result = await deletePost(postId);
        manaqishQueueDelete(postId);
        const keys = existing ? buildRowAliases(existing) : [postId];
        try {
          const tabs = await chrome.tabs.query({ url: ['*://*.facebook.com/*'] });
          for (const tab of tabs) {
            if (!tab.id || tab.id === sender?.tab?.id) continue;
            chrome.tabs.sendMessage(tab.id, { type: 'POST_DELETED_EXTERNALLY', keys, postId }).catch(() => {});
          }
        } catch (e) {
          console.debug('[Facebook Post Saver] cross-tab delete notify skipped:', e);
        }
        return { ok: true, ...result, keys };
      }

      case 'DOWNLOAD_MEDIA': {
        const result = await downloadMedia(
          message.url,
          message.filename,
          message.mediaType === 'video' ? 'video' : 'image'
        );
        return { ok: true, ...result };
      }

      case 'UPDATE_POST_MARKDOWN': {
        // Local-only by design: editing happens inside مناقيش, and the
        // extension never overwrites a row that already exists on the
        // server (see manaqish-sync.js). Pushing this edit would also
        // re-send `savedAt`, stamping a fresh time on an old post.
        const result = await updatePostMarkdown(message.id, message.markdownText);
        return { ok: true, ...result };
      }

      case 'MARK_EXPORTED': {
        const ids = Array.isArray(message.ids) ? message.ids : [];
        const result = await markPostsExported(ids, message.exportFileName);
        return { ok: true, ...result };
      }

      case 'IMPORT_POSTS': {
        const rows = Array.isArray(message.posts) ? message.posts : [];
        const result = await importPosts(rows);
        return { ok: true, ...result };
      }

      default:
        return { ok: false, error: 'رسالة غير معروفة.' };
    }
  };

  handle()
    .then(sendResponse)
    .catch((error) => {
      console.error('[Facebook Post Saver] background error:', error);
      sendResponse({ ok: false, error: error?.message || 'حدث خطأ غير معروف.' });
    });

  return true;
});
