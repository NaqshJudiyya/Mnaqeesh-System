const POSTS = 'GET_ALL_POSTS';
const IMPORT = 'IMPORT_POSTS';
const MARK_EXPORTED = 'MARK_EXPORTED';
const DELETE_POST = 'DELETE_POST';

let allRows = [];
let filterText = '';
const tableFilters = {
  number: '',
  author: '',
  date: '',
  time: '',
  privacy: '',
  text: '',
  images: '',
  video: '',
  post: ''
};

const tableBody = document.getElementById('fps-table-body');
const emptyState = document.getElementById('fps-empty-state');
const countLabel = document.getElementById('fps-count');
const searchInput = document.getElementById('fps-search');
const statusEl = document.getElementById('fps-status');
const exportMode = document.getElementById('fps-export-mode');
const numberFilter = document.getElementById('fps-filter-number');
const authorFilter = document.getElementById('fps-filter-author');
const dateFilter = document.getElementById('fps-filter-date');
const timeFilter = document.getElementById('fps-filter-time');
const privacyFilter = document.getElementById('fps-filter-privacy');
const textFilter = document.getElementById('fps-filter-text');
const imagesFilter = document.getElementById('fps-filter-images');
const videoFilter = document.getElementById('fps-filter-video');
const postFilter = document.getElementById('fps-filter-post');

if (new URLSearchParams(location.search).get('view') === 'full') {
  document.body.classList.add('fps-full-page');
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function privacyLabel(value) {
  return value === 'public' ? 'عام' : value === 'friends' ? 'للأصدقاء' : value === 'private' ? 'أنا فقط' : 'غير معروف';
}

function normalizeRow(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const imageUrls = Array.isArray(row.imageUrls) ? row.imageUrls : Array.isArray(row.images) ? row.images : [];
  return {
    id: String(row.id || row.postUrl || row.post_url || '').trim(),
    author: String(row.author || row.account || '').trim() || 'غير معروف',
    date: String(row.date || '').trim(),
    time: String(row.time || '').trim(),
    privacy: ['public', 'friends', 'private'].includes(row.privacy) ? row.privacy : 'unknown',
    text: String(row.text || '').trim(),
    markdownText: String(row.markdownText ?? '').trim(),
    imageUrls: imageUrls.map((v) => String(v || '').trim()).filter(Boolean),
    imageDirectUrls: Array.isArray(row.imageDirectUrls) ? row.imageDirectUrls.map((v) => String(v || '').trim()).filter(Boolean) : [],
    videoUrl: String(row.videoUrl ?? row.video_url ?? '').trim(),
    videoDirectUrl: String(row.videoDirectUrl ?? row.video_direct_url ?? '').trim(),
    postUrl: String(row.postUrl ?? row.post_url ?? '').trim(),
    savedAt: String(row.savedAt || '').trim(),
    exported: row.exported === true,
    exportedAt: String(row.exportedAt || '').trim(),
    exportFileName: String(row.exportFileName || '').trim()
  };
}

function showStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
  if (!message) return;
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = '';
  }, 5000);
}

function getSafeHttpUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function isDirectFacebookMediaUrl(rawUrl) {
  const safeUrl = getSafeHttpUrl(rawUrl);
  if (!safeUrl) return false;
  try {
    const hostname = new URL(safeUrl).hostname;
    return /(^|\.)fbcdn\.net$/i.test(hostname)
      || /(^|\.)fbsbx\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

function getFileExtension(rawUrl, fallback) {
  try {
    const path = decodeURIComponent(new URL(rawUrl).pathname);
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {}
  return fallback;
}

function sanitizeFilePart(value, fallback = 'media') {
  return String(value || fallback)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 70) || fallback;
}

function buildMediaFileName(row, rowNumber, mediaType, mediaIndex, downloadUrl) {
  const author = sanitizeFilePart(row.author, 'facebook');
  const extension = getFileExtension(downloadUrl, mediaType === 'video' ? 'mp4' : 'jpg');
  return `facebook-post-${rowNumber}-${author}-${mediaType}-${mediaIndex + 1}.${extension}`;
}

function renderLink(url, label) {
  const safeUrl = getSafeHttpUrl(url);
  if (!safeUrl) return '';
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" referrerpolicy="strict-origin-when-cross-origin">${escapeHtml(label || safeUrl)}</a>`;
}

function renderMediaLink({ pageUrl, downloadUrl, label, mediaType, rowId, mediaIndex, fileName }) {
  const safePageUrl = getSafeHttpUrl(pageUrl);
  const safeDownloadUrl = getSafeHttpUrl(downloadUrl);
  if (!safePageUrl && !safeDownloadUrl) return '—';

  const visibleUrl = safePageUrl || safeDownloadUrl;

  return `<div class="fps-media-link-row">
    <span class="fps-media-link">${renderLink(visibleUrl, label)}</span>
  </div>`;
}

function previewText(value, max = 46) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'لا يوجد نص';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function markdownEscapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function renderMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '<p class="fps-md-empty-preview">لا يوجد محتوى.</p>';

  const lines = source.split('\n');
  const out = [];
  let listType = null;

  const inline = (raw) => {
    let x = markdownEscapeHtml(raw);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img alt="$1" src="$2">');
    x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    x = x.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    x = x.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
    return x;
  };

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { closeList(); continue; }
    let m = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (m) { closeList(); const level = m[1].length; out.push(`<h${level}>${inline(m[2])}</h${level}>`); continue; }
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) { closeList(); out.push('<hr>'); continue; }
    m = trimmed.match(/^>\s?(.*)$/);
    if (m) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    m = trimmed.match(/^[-*+]\s+(.+)$/);
    if (m) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType='ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    m = trimmed.match(/^\d+\.\s+(.+)$/);
    if (m) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType='ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (listType) closeList();
    out.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();
  return out.join('');
}

// ملاحظة: محرّر Markdown أُزيل من الإضافة بقرار من صاحب النظام.
// صار التنسيق والتحرير يتمّان داخل نظام «مناقيش» فقط.
// دالة renderMarkdown تبقى لأن تصدير WordPress يستخدمها.

function parsePostSortParts(row) {
  const dateMatch = String(row.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timeMatch = String(row.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch) return null;
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const hasTime = Boolean(timeMatch);
  const hour = hasTime ? Number(timeMatch[1]) : 0;
  const minute = hasTime ? Number(timeMatch[2]) : 0;
  if (hasTime && (hour > 23 || minute > 59)) return null;

  const key = (((year * 12 + month) * 31 + day) * 24 + hour) * 60 + minute;
  return { key, hasTime, year, month, day };
}

function compareRowsByPostDateTime(a, b) {
  const pa = parsePostSortParts(a);
  const pb = parsePostSortParts(b);

  if (pa && pb) {
    if (pa.key !== pb.key) return pb.key - pa.key;
    if (pa.hasTime !== pb.hasTime) return pa.hasTime ? -1 : 1;
  } else if (pa && !pb) {
    return -1;
  } else if (!pa && pb) {
    return 1;
  }

  const savedA = Date.parse(a.savedAt || '') || 0;
  const savedB = Date.parse(b.savedAt || '') || 0;
  return savedB - savedA;
}

function setSelectOptions(select, options, selectedValue = '') {
  if (!select) return;
  const previous = selectedValue;
  select.innerHTML = '<option value="">الكل</option>' + options.map(({ value, label }) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
  ).join('');
  select.value = options.some((item) => item.value === previous) ? previous : '';
}

function populateColumnFilters() {
  const currentAuthor = tableFilters.author;
  const currentPrivacy = tableFilters.privacy;

  const authors = [...new Set(
    allRows
      .map((row) => String(row.author || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ar'));

  const privacies = [
    { value: 'public', label: 'عام' },
    { value: 'friends', label: 'للأصدقاء' },
    { value: 'private', label: 'أنا فقط' },
    { value: 'unknown', label: 'غير معروف' }
  ].filter(({ value }) => allRows.some((row) => row.privacy === value));

  setSelectOptions(
    authorFilter,
    authors.map((value) => ({ value, label: value })),
    currentAuthor
  );

  setSelectOptions(privacyFilter, privacies, currentPrivacy);

  // إعادة القيم الحالية للحقول النصية بعد إعادة بناء الفلاتر.
  if (numberFilter) numberFilter.value = tableFilters.number;
  if (dateFilter) dateFilter.value = tableFilters.date;
  if (timeFilter) timeFilter.value = tableFilters.time;
  if (textFilter) textFilter.value = tableFilters.text;
  if (imagesFilter) imagesFilter.value = tableFilters.images;
  if (videoFilter) videoFilter.value = tableFilters.video;
  if (postFilter) postFilter.value = tableFilters.post;
}

function matchesLinkFilter(value, filter) {
  if (!filter) return true;
  const hasLink = Boolean(String(value || '').trim());
  return filter === 'has' ? hasLink : !hasLink;
}

function matchesTextFilter(value, filter) {
  const needle = String(filter || '').trim().toLocaleLowerCase('ar');
  if (!needle) return true;
  return String(value || '').toLocaleLowerCase('ar').includes(needle);
}

function renderTable() {
  const needle = filterText.toLocaleLowerCase('ar');
  const rowNumbers = new Map(allRows.map((row, index) => [row.id, index + 1]));

  const filtered = allRows.filter((row) => {
    const rowNumber = rowNumbers.get(row.id) || 0;
    const matchesSearch = !needle || `${row.author} ${row.text}`.toLocaleLowerCase('ar').includes(needle);
    const matchesNumber = !tableFilters.number || String(rowNumber) === String(tableFilters.number).trim();
    const matchesAuthor = !tableFilters.author || row.author === tableFilters.author;
    const matchesDate = matchesTextFilter(row.date, tableFilters.date);
    const matchesTime = matchesTextFilter(row.time, tableFilters.time);
    const matchesPrivacy = !tableFilters.privacy || row.privacy === tableFilters.privacy;
    const matchesText = matchesTextFilter(row.markdownText || row.text, tableFilters.text);
    const matchesImages = matchesLinkFilter(row.imageUrls?.length, tableFilters.images);
    const matchesVideo = matchesLinkFilter(row.videoUrl, tableFilters.video);
    const matchesPost = matchesLinkFilter(row.postUrl, tableFilters.post);
    return matchesSearch && matchesNumber && matchesAuthor && matchesDate && matchesTime
      && matchesPrivacy && matchesText && matchesImages && matchesVideo && matchesPost;
  });

  const hasActiveFilters = Boolean(
    needle || tableFilters.number || tableFilters.author || tableFilters.date || tableFilters.time
    || tableFilters.privacy || tableFilters.text || tableFilters.images || tableFilters.video || tableFilters.post
  );

  countLabel.textContent = hasActiveFilters
    ? `${allRows.length} منشور — المعروض ${filtered.length}`
    : `${allRows.length} منشور`;

  if (!filtered.length) {
    tableBody.innerHTML = '';
    emptyState.hidden = false;
    emptyState.textContent = allRows.length && hasActiveFilters
      ? 'لا توجد نتائج مطابقة للفلاتر الحالية.'
      : 'لا توجد منشورات محفوظة بعد. افتح فيسبوك واضغط «📥 حفظ» فوق المنشور.';
    return;
  }

  emptyState.hidden = true;
  tableBody.innerHTML = filtered.map((row) => {
    const rowNumber = rowNumbers.get(row.id) || 0;
    const imagesHtml = row.imageUrls.length
      ? `<div class="fps-link-list">${row.imageUrls.map((url, i) => {
          const downloadUrl = row.imageDirectUrls[i] || (isDirectFacebookMediaUrl(url) ? url : '');
          const fileName = buildMediaFileName(row, rowNumber, 'image', i, downloadUrl || url);
          return renderMediaLink({
            pageUrl: url,
            downloadUrl,
            label: `صورة ${i + 1}`,
            mediaType: 'image',
            rowId: row.id,
            mediaIndex: i,
            fileName
          });
        }).join('')}</div>`
      : '—';

    const textPreview = escapeHtml(previewText(row.markdownText || row.text));
    const fullText = escapeHtml(row.markdownText || row.text || 'لا يوجد نص');
    const textHtml = (row.text || row.markdownText)
      ? `<details class="fps-text-details"><summary title="${fullText}">${textPreview}</summary><div class="fps-text-content">${fullText}</div></details>`
      : `<span class="fps-empty-text">لا يوجد نص</span>`;

    const videoDownloadUrl = row.videoDirectUrl || (isDirectFacebookMediaUrl(row.videoUrl) ? row.videoUrl : '');
    const videoHtml = row.videoUrl
      ? renderMediaLink({
          pageUrl: row.videoUrl,
          downloadUrl: videoDownloadUrl,
          label: 'فتح الفيديو',
          mediaType: 'video',
          rowId: row.id,
          mediaIndex: 0,
          fileName: buildMediaFileName(row, rowNumber, 'video', 0, videoDownloadUrl || row.videoUrl)
        })
      : '—';

    const postHtml = row.postUrl ? renderLink(cleanFacebookPostUrl(row.postUrl), 'فتح المنشور') : '—';

    return `<tr>
      <td class="fps-number-cell">${rowNumber}<button type="button" class="fps-delete-btn" data-delete-post="${escapeHtml(row.id)}" title="حذف المنشور" aria-label="حذف المنشور">×</button></td>
      <td>${escapeHtml(row.author)}</td>
      <td>${escapeHtml(row.date || '—')}</td>
      <td>${escapeHtml(row.time || '—')}</td>
      <td>${escapeHtml(privacyLabel(row.privacy))}</td>
      <td class="fps-text-cell">
        <div class="fps-text-cell-inner">
          <div class="fps-text-main">${textHtml}</div>
        </div>
      </td>
      <td>${imagesHtml}</td>
      <td>${videoHtml}</td>
      <td>${postHtml}</td>
    </tr>`;
  }).join('');
}

function openLocalPostsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('facebookPostSaverDB', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح قاعدة بيانات المنشورات.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('posts')) db.createObjectStore('posts', { keyPath: 'id' });
    };
  });
}

function readLocalPosts() {
  return openLocalPostsDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('posts', 'readonly');
    const request = tx.objectStore('posts').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('تعذر قراءة المنشورات المحفوظة.'));
    tx.onabort = () => reject(tx.error || new Error('فشلت قراءة قاعدة بيانات المنشورات.'));
  }));
}

async function loadRows() {
  try {
    let posts = null;
    let runtimeError = null;

    try {
      const response = await chrome.runtime.sendMessage({ type: POSTS });
      if (!response?.ok) throw new Error(response?.error || 'تعذر قراءة البيانات من Service Worker.');
      posts = response.posts || [];
    } catch (error) {
      runtimeError = error;
      console.warn('[Facebook Post Saver] runtime load failed; using direct IndexedDB fallback.', error);
    }

    // الـPopup يقرأ نفس IndexedDB مباشرة كمسار احتياطي.
    // هذا يمنع فشل الجدول إذا كان Service Worker أعيد تشغيله أو تعذر الاتصال به لحظيًا.
    if (!Array.isArray(posts)) posts = await readLocalPosts();

    allRows = posts.map(normalizeRow).filter((row) => row.id);
    allRows.sort(compareRowsByPostDateTime);
    populateColumnFilters();
    renderTable();

    if (runtimeError) {
      console.info('[Facebook Post Saver] جدول المنشورات حُمّل مباشرة من IndexedDB.');
    }
  } catch (error) {
    console.error('[Facebook Post Saver] load error:', error);
    showStatus(`تعذر تحميل جدول البيانات: ${error?.message || 'خطأ غير معروف'}`, true);
  }
}

function todayStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function getPeriodInfo(row) {
  const parts = parsePostSortParts(row);
  if (!parts) return null;
  return {
    year: String(parts.year),
    month: `${parts.year}-${String(parts.month).padStart(2, '0')}`
  };
}

function groupRowsForExport(rows, mode) {
  if (mode === 'all') {
    return [{ key: 'all', rows, fileSuffix: '' }];
  }

  const groups = new Map();
  for (const row of rows) {
    const info = getPeriodInfo(row);
    if (!info) continue;
    const key = mode === 'year' ? info.year : info.month;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupRows]) => ({ key, rows: groupRows, fileSuffix: `-${key}` }));
}

function buildMarkdownForRow(row, index) {
  const lines = [];
  lines.push(`## منشور ${index + 1}`);
  lines.push('');
  lines.push(`**اسم الحساب:** ${row.author || 'غير معروف'}`);
  lines.push(`**التاريخ:** ${row.date || 'غير متوفر'}`);
  lines.push(`**الوقت:** ${row.time || 'غير متوفر'}`);
  lines.push(`**جمهور المنشور:** ${privacyLabel(row.privacy)}`);
  lines.push(`**رابط المنشور:** ${row.postUrl || 'غير متوفر'}`);
  lines.push('');
  lines.push('### النص');
  lines.push('');
  lines.push(String(row.markdownText || row.text || 'لا يوجد نص').trim());
  lines.push('');

  if (row.imageUrls?.length) {
    lines.push('### الصور');
    lines.push('');
    row.imageUrls.forEach((url, i) => lines.push(`- [صورة ${i + 1}](${url})`));
    lines.push('');
  }
  if (row.videoUrl) {
    lines.push('### الفيديو');
    lines.push('');
    lines.push(`[فتح الفيديو](${row.videoUrl})`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildMarkdownDocument(rows, groupKey) {
  const header = [
    '# Facebook Post Saver',
    '',
    `الفترة: ${groupKey || 'الكل'}`,
    `عدد المنشورات: ${rows.length}`,
    '',
    '---',
    ''
  ];
  const body = rows.map((row, index) => buildMarkdownForRow(row, index)).join('\n\n---\n\n');
  return `${header.join('\n')}${body}\n`;
}

async function markExported(rows, fileName) {
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return;
  const response = await chrome.runtime.sendMessage({ type: MARK_EXPORTED, ids, exportFileName: fileName });
  if (!response?.ok) throw new Error(response?.error || 'تعذر تحديث حالة التصدير');
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  allRows = allRows.map((row) => idSet.has(row.id)
    ? { ...row, exported: true, exportedAt: now, exportFileName: fileName }
    : row);
}

async function exportRows(mode, format) {
  if (!allRows.length) {
    showStatus('لا توجد بيانات لتصديرها.', true);
    return;
  }

  const groups = groupRowsForExport(allRows, mode);
  const undatedCount = mode === 'all' ? 0 : allRows.filter((row) => !getPeriodInfo(row)).length;
  if (!groups.length) {
    showStatus('لا توجد منشورات بتاريخ صالح للتصدير بهذا النطاق.', true);
    return;
  }

  let exportedCount = 0;
  const extension = format === 'xlsx' ? 'xlsx' : format === 'md' ? 'md' : format === 'wp' ? 'xml' : 'json';
  const label = format === 'xlsx' ? 'Excel' : format === 'md' ? 'Markdown' : format === 'wp' ? 'WordPress WXR' : 'JSON';

  try {
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const fileBase = `facebook-post-saver${group.fileSuffix}`;
      const fileName = `${fileBase}.${extension}`;
      const stamp = new Date().toISOString();
      const rowsForFile = group.rows.map((row) => ({
        ...row,
        exported: true,
        exportedAt: stamp,
        exportFileName: fileName
      }));

      if (format === 'xlsx') {
        const xlsxBytes = buildXlsx(rowsForFile);
        const blob = new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        downloadBlob(blob, fileName);
      } else if (format === 'md') {
        const markdown = buildMarkdownDocument(rowsForFile, group.key);
        const blob = new Blob([`\ufeff${markdown}`], { type: 'text/markdown;charset=utf-8' });
        downloadBlob(blob, fileName);
      } else if (format === 'wp') {
        const wxr = buildWordPressWxr(rowsForFile, group.key);
        const blob = new Blob([`\ufeff${wxr}`], { type: 'application/xml;charset=utf-8' });
        downloadBlob(blob, fileName);
      } else {
        const payload = {
          format: 'facebook-post-saver',
          version: 2,
          exportedAt: stamp,
          exportMode: mode,
          exportPeriod: group.key,
          rows: rowsForFile
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        downloadBlob(blob, fileName);
      }

      await markExported(group.rows, fileName);
      exportedCount += group.rows.length;
      renderTable();
      if (i < groups.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const undatedMessage = undatedCount ? ` — ${undatedCount} بدون تاريخ لم تُصدّر بهذا التقسيم` : '';
    showStatus(`تم تصدير ${exportedCount} منشور كـ ${label} (${groups.length} ملف)${undatedMessage}.`);
  } catch (error) {
    console.error('[Facebook Post Saver] export error:', error);
    showStatus(`حدث خطأ أثناء التصدير. تم إنهاء ${exportedCount} منشور حتى الآن.`, true);
    await loadRows();
  }
}


function cleanFacebookPostUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return value;
    url.hash = '';
    const tracking = new Set([
      '__cft__', '__tn__', 'ref', 'refid', 'notif_id', 'notif_t', 'comment_tracking',
      'locale', 'mibextid', 'paipv', 'acontext'
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (tracking.has(key) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = url.searchParams.toString();
    return query ? `${url.origin}${path}?${query}` : `${url.origin}${path}`;
  } catch {
    return value;
  }
}

function xmlEscapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlCdata(value) {
  return `<![CDATA[${String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function sanitizeWordPressSlug(value) {
  return String(value || 'post')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-')
    .slice(0, 80) || 'post';
}

function getWordPressTitle(row, index) {
  const source = String(row.markdownText || row.text || '').replace(/\r\n?/g, '\n').trim();
  const heading = source.match(/^#{1,6}\s+(.+)$/m);
  if (heading?.[1]) return heading[1].replace(/[*_`]/g, '').trim().slice(0, 150) || `منشور ${index + 1}`;
  const firstBlock = source.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (firstBlock) return firstBlock.slice(0, 150);
  return `منشور ${index + 1} — ${row.date || 'بدون تاريخ'}`;
}

function parseWpLocalDateTime(row) {
  const dm = String(row.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const tm = String(row.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!dm) return null;
  const y = Number(dm[3]), mo = Number(dm[2]), d = Number(dm[1]);
  const h = tm ? Number(tm[1]) : 0, min = tm ? Number(tm[2]) : 0;
  const date = new Date(y, mo - 1, d, h, min, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatWpLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

function formatWpGmt(date) {
  const utc = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')} ${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}:00`;
}

function buildWordPressPostHtml(row) {
  const markdown = String(row.markdownText || row.text || '').trim();
  let html = renderMarkdown(markdown);
  const directImages = Array.isArray(row.imageDirectUrls) ? row.imageDirectUrls.filter(Boolean) : [];
  const pageImages = Array.isArray(row.imageUrls) ? row.imageUrls.filter(Boolean) : [];
  const images = directImages.length ? directImages : pageImages;
  if (images.length) {
    html += '<p class="facebook-post-saver-images">';
    images.forEach((url, i) => {
      const safe = xmlEscapeText(url);
      html += `<a href="${safe}"><img src="${safe}" alt="صورة ${i + 1}" /></a>`;
    });
    html += '</p>';
  }
  if (row.videoUrl) {
    const safe = xmlEscapeText(row.videoUrl);
    html += `<p><a href="${safe}">فيديو المنشور</a></p>`;
  }
  const cleanedPostUrl = cleanFacebookPostUrl(row.postUrl);
  if (cleanedPostUrl) {
    const safe = xmlEscapeText(cleanedPostUrl);
    html += `<hr /><p><strong>المصدر:</strong> <a href="${safe}">${safe}</a></p>`;
  }
  return html || '<p></p>';
}

function buildWordPressPostItem(row, index, exportStamp) {
  const postNumber = index + 1;
  const title = getWordPressTitle(row, index);
  const postDate = parseWpLocalDateTime(row) || new Date();
  const local = formatWpLocal(postDate);
  const gmt = formatWpGmt(postDate);
  const contentHtml = buildWordPressPostHtml(row);
  const slug = sanitizeWordPressSlug(title);
  const idSeed = String(row.id || `row-${postNumber}`);
  const guid = `facebook-post-saver:${idSeed}`;
  const wxrSourceLink = `https://facebook-post-saver.invalid/import/${encodeURIComponent(idSeed)}`;
  const sourceUrl = cleanFacebookPostUrl(row.postUrl);
  const imageUrls = Array.isArray(row.imageDirectUrls) && row.imageDirectUrls.length ? row.imageDirectUrls : (row.imageUrls || []);
  const meta = [
    ['facebook_post_url', sourceUrl],
    ['facebook_account', row.author || '' ],
    ['facebook_date', row.date || '' ],
    ['facebook_time', row.time || '' ],
    ['facebook_privacy', privacyLabel(row.privacy)],
    ['facebook_image_urls', JSON.stringify(imageUrls)],
    ['facebook_video_url', row.videoUrl || '' ],
    ['facebook_saver_exported_at', exportStamp]
  ];
  const postmeta = meta.map(([k, v]) => `\n      <wp:postmeta><wp:meta_key>${xmlCdata(k)}</wp:meta_key><wp:meta_value>${xmlCdata(v)}</wp:meta_value></wp:postmeta>`).join('');

  return `\n  <item>
    <title>${xmlCdata(title)}</title>
    <link>${xmlCdata(wxrSourceLink)}</link>
    <pubDate>${postDate.toUTCString()}</pubDate>
    <dc:creator>${xmlCdata('facebook-post-saver')}</dc:creator>
    <guid isPermaLink="false">${xmlEscapeText(guid)}</guid>
    <description>${xmlCdata('Facebook Post Saver import')}</description>
    <content:encoded>${xmlCdata(contentHtml)}</content:encoded>
    <excerpt:encoded>${xmlCdata('')}</excerpt:encoded>
    <wp:post_id>${postNumber}</wp:post_id>
    <wp:post_date>${xmlCdata(local)}</wp:post_date>
    <wp:post_date_gmt>${xmlCdata(gmt)}</wp:post_date_gmt>
    <wp:comment_status>${xmlCdata('closed')}</wp:comment_status>
    <wp:ping_status>${xmlCdata('closed')}</wp:ping_status>
    <wp:post_name>${xmlCdata(slug)}</wp:post_name>
    <wp:status>${xmlCdata('draft')}</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>${xmlCdata('post')}</wp:post_type>
    <wp:post_password>${xmlCdata('')}</wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>${postmeta}
  </item>`;
}

function buildWordPressWxr(rows, groupKey) {
  const exportStamp = new Date().toISOString();
  const items = rows.map((row, index) => buildWordPressPostItem(row, index, exportStamp)).join('');
  // لا نستخدم facebook.com هنا حتى لا يعيد WordPress كتابة روابط Facebook عند تفعيل URL rewriting أثناء الاستيراد.
  const siteUrl = 'https://facebook-post-saver.invalid/';
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>${xmlCdata('Facebook Post Saver')}</title>
    <link>${xmlCdata(siteUrl)}</link>
    <description>${xmlCdata('Export created by Facebook Post Saver')}</description>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <language>ar</language>
    <wp:wxr_version>${xmlCdata('1.2')}</wp:wxr_version>
    <wp:base_site_url>${xmlCdata(siteUrl)}</wp:base_site_url>
    <wp:base_blog_url>${xmlCdata(siteUrl)}</wp:base_blog_url>
    <wp:author>
      <wp:author_id>1</wp:author_id>
      <wp:author_login>${xmlCdata('facebook-post-saver')}</wp:author_login>
      <wp:author_email>${xmlCdata('no-reply@example.invalid')}</wp:author_email>
      <wp:author_display_name>${xmlCdata('Facebook Post Saver')}</wp:author_display_name>
      <wp:author_first_name>${xmlCdata('')}</wp:author_first_name>
      <wp:author_last_name>${xmlCdata('')}</wp:author_last_name>
    </wp:author>${items}
  </channel>
</rss>\n`;
}

async function importJson(file) {
  try {
    let text = await file.text();
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('الملف فارغ.');

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      // بعض البرامج تضيف BOM أو تحفظ JSON كنص مقتبس؛ نزيل BOM ونحاول مرة أخيرة.
      const cleaned = text.replace(/^\s*\uFEFF/, '');
      raw = JSON.parse(cleaned);
    }

    // دعم كل صيغ التصدير السابقة من الإضافة، وليس v2.9 فقط.
    const importedRows = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.rows)
        ? raw.rows
        : Array.isArray(raw?.posts)
          ? raw.posts
          : Array.isArray(raw?.data?.rows)
            ? raw.data.rows
            : Array.isArray(raw?.data?.posts)
              ? raw.data.posts
              : null;

    if (!Array.isArray(importedRows)) {
      throw new Error('الملف لا يحتوي على rows/posts صالحة.');
    }

    const response = await chrome.runtime.sendMessage({ type: IMPORT, posts: importedRows });
    if (!response?.ok) throw new Error(response?.error || 'فشل الاستيراد');

    await loadRows();
    showStatus(`تم استيراد ${response.added || 0} منشور، وتحديث ${response.updated || 0}، وتجاهل ${response.skipped || 0}.`);
  } catch (error) {
    console.error('[Facebook Post Saver] import error:', error);
    showStatus(`فشل استيراد JSON: ${error?.message || 'صيغة غير صالحة.'}`, true);
  }
}

function openFullTab() {
  const url = `${chrome.runtime.getURL('popup.html')}?view=full`;
  const opened = window.open(url, '_blank');
  if (!opened) showStatus('تعذر فتح التبويب الجديد. اسمح بفتح النوافذ من الإضافة.', true);
}

document.getElementById('fps-export-json').addEventListener('click', () => exportRows(exportMode.value, 'json'));
document.getElementById('fps-export-md').addEventListener('click', () => exportRows(exportMode.value, 'md'));
document.getElementById('fps-export-wp').addEventListener('click', () => exportRows(exportMode.value, 'wp'));
document.getElementById('fps-export-xlsx').addEventListener('click', () => exportRows(exportMode.value, 'xlsx'));

function bindColumnFilter(select, key) {
  select?.addEventListener('input', (event) => {
    tableFilters[key] = event.target.value;
    renderTable();
  });
  select?.addEventListener('change', (event) => {
    tableFilters[key] = event.target.value;
    renderTable();
  });
}

bindColumnFilter(numberFilter, 'number');
bindColumnFilter(authorFilter, 'author');
bindColumnFilter(dateFilter, 'date');
bindColumnFilter(timeFilter, 'time');
bindColumnFilter(privacyFilter, 'privacy');
bindColumnFilter(textFilter, 'text');
bindColumnFilter(imagesFilter, 'images');
bindColumnFilter(videoFilter, 'video');
bindColumnFilter(postFilter, 'post');
document.getElementById('fps-open-tab').addEventListener('click', openFullTab);
document.getElementById('fps-import-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importJson(file);
  event.target.value = '';
});

let searchTimer = null;
searchInput.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterText = event.target.value.trim();
    renderTable();
  }, 120);
});

tableBody.addEventListener('click', async (event) => {
  const deleteButton = event.target.closest?.('[data-delete-post]');
  if (deleteButton) {
    const id = String(deleteButton.dataset.deletePost || '');
    const row = allRows.find((item) => item.id === id);
    if (!row) return;
    const confirmed = globalThis.confirm(`حذف منشور ${row.author || 'غير معروف'}؟\nلا يمكن التراجع عن هذا الحذف من داخل الإضافة.`);
    if (!confirmed) return;
    deleteButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: DELETE_POST, id });
      if (!response?.ok) throw new Error(response?.error || 'تعذر حذف المنشور');
      allRows = allRows.filter((item) => item.id !== id);
      populateColumnFilters();
      renderTable();
      showStatus('تم حذف المنشور من الجدول.');
    } catch (error) {
      console.error('[Facebook Post Saver] delete error:', error);
      deleteButton.disabled = false;
      showStatus('تعذر حذف المنشور.', true);
    }
    return;
  }
});

loadRows();
