'use client';

import { useEffect, useRef, useState } from 'react';
import { renderMarkdownHtml, textStats } from '@/lib/markdown';

type Props = {
  postId: string;
  /** The markdown currently in effect: an in-app edit, else the extension's. */
  initialMarkdown: string;
  /** The extension's saved markdown, offered as a reset target. */
  originalMarkdown: string;
  /** Raw scraped text, used when the extension saved no markdown. */
  originalText: string;
  isEdited: boolean;
  /**
   * The manual workflow state of the post. Only the manager and the member
   * who saved the post get to change it, so the caller decides whether to
   * pass a value at all — passing nothing hides the control.
   */
  initialStatus?: string;
  /** Called after a successful save, with the markdown now in effect. */
  onSaved?: (markdown: string) => void;
  /** Lets the surrounding modal disable its own close/save affordances. */
  onBusyChange?: (busy: boolean) => void;
};

type ToolbarAction = 'bold' | 'italic' | 'h2' | 'bullet' | 'quote' | 'code' | 'link';

/**
 * Markdown editor — the مناقيش counterpart of the extension's own editor.
 *
 * The toolbar, the side-by-side live preview, and the "restore original"
 * action deliberately mirror the extension so the two feel like one
 * feature. Rendering goes through the same renderer port
 * (`lib/markdown.ts`), so a post previews identically in both places.
 */
export default function MarkdownEditor({
  postId,
  initialMarkdown,
  originalMarkdown,
  originalText,
  isEdited,
  initialStatus,
  onSaved,
  onBusyChange
}: Props) {
  const [value, setValue] = useState(initialMarkdown);
  const [status, setStatus] = useState(initialStatus ?? 'new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSetStatus = initialStatus !== undefined;
  const preview = renderMarkdownHtml(value);
  const originalFallback = (originalMarkdown || originalText || '').trim();
  const isDirty = value !== initialMarkdown || (canSetStatus && status !== initialStatus);
  const stats = textStats(value);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /** Focuses the textarea and restores a selection after a state update. */
  function selectRange(from: number, to: number) {
    window.requestAnimationFrame(() => {
      const area = textareaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(from, to);
    });
  }

  /** Wraps or prefixes the current selection with Markdown. */
  function applyAction(action: ToolbarAction) {
    const area = textareaRef.current;
    if (!area) return;

    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);

    const wrap = (token: string) => {
      const inner = selected || 'نص';
      setValue(`${before}${token}${inner}${token}${after}`);
      selectRange(start + token.length, start + token.length + inner.length);
    };

    // Block-level actions start on a fresh line.
    const linePrefix = before.endsWith('\n') || before === '' ? '' : '\n';

    switch (action) {
      case 'bold':
        wrap('**');
        break;
      case 'italic':
        wrap('*');
        break;
      case 'code':
        wrap('`');
        break;
      case 'h2':
        setValue(`${before}${linePrefix}## ${selected || 'عنوان'}${after}`);
        break;
      case 'bullet': {
        const lines = (selected || 'عنصر').split('\n').map((line) => `- ${line}`).join('\n');
        setValue(`${before}${linePrefix}${lines}${after}`);
        break;
      }
      case 'quote':
        setValue(`${before}${linePrefix}> ${selected || 'اقتباس'}${after}`);
        break;
      case 'link':
        setValue(`${before}[${selected || 'نص الرابط'}](https://)${after}`);
        break;
      default:
        break;
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/posts/${postId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: value,
          text: value,
          ...(canSetStatus ? { status } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error || 'تعذر حفظ التعديل.');
      }
      const cleared = Boolean((payload as { cleared?: boolean }).cleared);
      setNotice(cleared ? 'تم استعادة المحتوى الأصلي من الإضافة.' : 'تم حفظ التعديل.');
      onSaved?.(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ التعديل.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="md-editor">
      <div className="md-toolbar" role="toolbar" aria-label="أدوات Markdown">
        <button type="button" title="عريض" onClick={() => applyAction('bold')}><strong>B</strong></button>
        <button type="button" title="مائل" onClick={() => applyAction('italic')}><em>I</em></button>
        <button type="button" title="عنوان" onClick={() => applyAction('h2')}>H2</button>
        <button type="button" title="قائمة نقطية" onClick={() => applyAction('bullet')}>•</button>
        <button type="button" title="اقتباس" onClick={() => applyAction('quote')}>❯</button>
        <button type="button" title="كود" onClick={() => applyAction('code')}>&lt;/&gt;</button>
        <button type="button" title="رابط" onClick={() => applyAction('link')}>🔗</button>
        <button type="button" title="إدراج صورة" onClick={() => {
          const area = textareaRef.current;
          const start = area?.selectionStart ?? value.length;
          const before = value.slice(0, start);
          const after = value.slice(start);
          setValue(`${before}\n![وصف الصورة](https://)${after}`);
        }}>🖼</button>
        <span className="md-toolbar-spacer" />
        {isEdited && (
          <button
            type="button"
            title="استعادة النص الأصلي من الإضافة"
            onClick={() => {
              setValue(originalFallback);
              setNotice('تم استرجاع النص الأصلي. اضغط «حفظ التعديل» لتثبيته.');
              setError('');
            }}
          >
            ↺ الأصلي
          </button>
        )}
      </div>

      <div className="md-grid">
        <textarea
          ref={textareaRef}
          className="textarea md-input"
          dir="rtl"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="اكتب أو عدّل نص المنشور بصيغة Markdown…"
          aria-label="نص Markdown"
        />
        <div
          className="md-preview"
          dir="rtl"
          aria-label="معاينة Markdown"
          dangerouslySetInnerHTML={{
            __html: preview || '<p class="md-empty">لا يوجد محتوى للمعاينة.</p>'
          }}
        />
      </div>

      {error && <div className="notice error" style={{ margin: '10px 12px' }}>{error}</div>}
      {notice && <div className="notice" style={{ margin: '10px 12px' }}>{notice}</div>}

      <div className="modal-foot">
        <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {canSetStatus && (
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">حالة المنشور:</span>
              <select
                className="select"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                style={{ padding: '4px 8px', fontSize: 13 }}
              >
                <option value="new">عادي</option>
                <option value="final">نهائي</option>
                <option value="needs_review">يحتاج مراجعة</option>
              </select>
            </label>
          )}
          <span className="muted">
            {isDirty ? 'يوجد تغيير غير محفوظ' : isEdited ? 'المحتوى معدَّل داخل النظام' : 'المحتوى كما حفظته الإضافة'}
          </span>
          <span className="md-stats" title="عدد الكلمات وعدد الحروف (بدون علامات التنسيق)">
            <span><strong>{stats.words}</strong> كلمة</span>
            <span className="md-stats-sep">·</span>
            <span><strong>{stats.characters}</strong> حرفًا</span>
            <span className="md-stats-sep">·</span>
            <span className="muted">{stats.charactersNoSpaces} بدون مسافات</span>
          </span>
        </span>
        <span className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              setValue(initialMarkdown);
              if (canSetStatus) setStatus(initialStatus ?? 'new');
            }}
            disabled={busy || !isDirty}
          >
            تراجع
          </button>
          <button type="button" className="btn" onClick={save} disabled={busy || !isDirty}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ التعديل'}
          </button>
        </span>
      </div>
    </div>
  );
}
