'use client';

import { useRef, useState } from 'react';

type Props = {
  /** Called after a successful import so the table can reload. */
  onImported?: () => void;
};

type Result = {
  total: number;
  added: number;
  updated: number;
  skipped: number;
};

/**
 * JSON import — the counterpart of the extension's own importer.
 *
 * Accepts every archive shape the extension has produced and merges it
 * into the signed-in member's archive. Re-importing the same file updates
 * rows instead of duplicating them, so it is safe to retry.
 */
export default function ImportPanel({ onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);

    try {
      const body = new FormData();
      body.append('file', file);

      const response = await fetch('/api/import', { method: 'POST', body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error || 'تعذر الاستيراد.');
      }

      setResult(payload as Result);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر الاستيراد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="notice error">{error}</div>}

      <div className="notice">
        اختر ملف <strong>JSON</strong> صدّرته إضافة Facebook Post Saver. تُدعم كل صيغ التصدير
        القديمة والحديثة. المنشورات المكرّرة تُحدَّث ولا تُضاعف، فيمكنك تكرار الاستيراد بأمان.
      </div>

      <div className="field">
        <label htmlFor="import-file">ملف JSON</label>
        <input
          id="import-file"
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="input"
          style={{ width: '100%' }}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
            setError('');
          }}
        />
        {file && (
          <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>
            الملف المختار: <strong dir="ltr">{file.name}</strong> ({Math.round(file.size / 1024)} كيلوبايت)
          </p>
        )}
      </div>

      {result && (
        <div className="notice" style={{ marginTop: 12 }}>
          <strong>تم الاستيراد ✓</strong>
          <div className="credentials" style={{ marginTop: 8 }}>
            <div><span>في الملف</span><code dir="ltr">{result.total}</code></div>
            <div><span>جديد</span><code dir="ltr">{result.added}</code></div>
            <div><span>مُحدَّث</span><code dir="ltr">{result.updated}</code></div>
            <div><span>متجاهَل</span><code dir="ltr">{result.skipped}</code></div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            ستظهر المنشورات في الجدول بعد إغلاق هذه النافذة.
          </p>
        </div>
      )}

      <div className="modal-foot" style={{ margin: '16px -18px -16px', borderRadius: '0 0 14px 14px' }}>
        <span className="muted">
          يُستورد الملف إلى <strong>حسابك</strong>. للاستيراد لحساب عضو آخر، استخدم «تبديل الحساب» أولًا.
        </span>
        <button className="btn" onClick={upload} disabled={busy || !file}>
          {busy ? 'جارٍ الاستيراد…' : 'استيراد'}
        </button>
      </div>
    </>
  );
}
