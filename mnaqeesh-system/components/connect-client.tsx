'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * The extension handshake, client half.
 *
 * `manaqish-bridge.js` (injected into this page by the extension) listens
 * for exactly this message shape and relays it to the extension's service
 * worker:
 *
 *   { source: 'manaqish', type: 'MANAQISH_SESSION',
 *     session: { access_token, refresh_token, expires_at, email } }
 *
 * and answers with:
 *
 *   { source: 'fps-extension', type: 'MANAQISH_SESSION_ACK' }
 *
 * Two details matter and are easy to get wrong:
 *   - `targetOrigin` must be this page's own origin, because the bridge
 *     checks `event.origin === window.location.origin`.
 *   - `expires_at` must be in SECONDS. The extension multiplies it by
 *     1000 when deciding whether to refresh.
 */

type Phase = 'idle' | 'sending' | 'sent' | 'no-bridge' | 'error';

export default function ConnectClient() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [bridgeSeen, setBridgeSeen] = useState(false);
  const ackRef = useRef(false);

  // Watch for the extension's ACK.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'fps-extension') return;
      if (data.type === 'MANAQISH_SESSION_ACK') {
        ackRef.current = true;
        setBridgeSeen(true);
        setPhase('sent');
        setMessage('تم ربط الإضافة بحسابك بنجاح. يمكنك إغلاق هذه الصفحة والعودة إلى فيسبوك.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const sendSession = useCallback(async () => {
    setPhase('sending');
    setMessage('');
    ackRef.current = false;

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const session = data.session;
      if (!session?.access_token || !session.refresh_token) {
        throw new Error('لا توجد جلسة صالحة. أعد تسجيل الدخول.');
      }

      const payload = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        // Seconds, not milliseconds.
        expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
        email: session.user?.email ?? ''
      };

      window.postMessage(
        { source: 'manaqish', type: 'MANAQISH_SESSION', session: payload },
        window.location.origin
      );

      // The bridge answers synchronously through the service worker, but
      // give it a moment before declaring that the bridge is missing.
      window.setTimeout(() => {
        if (!ackRef.current) {
          setPhase('no-bridge');
          setMessage(
            'لم تصلنا إشارة من الإضافة. تأكد أن إضافة Facebook Post Saver مثبّتة في هذا المتصفح وفعّالة، ثم أعد المحاولة.'
          );
        }
      }, 1800);
    } catch (err) {
      setPhase('error');
      setMessage(err instanceof Error ? err.message : 'تعذر تجهيز جلسة الإضافة.');
    }
  }, []);

  // Try automatically on load, and again whenever the user retries.
  useEffect(() => {
    void sendSession();
  }, [sendSession, attempt]);

  const stepState = (index: number): string => {
    if (index === 0) return 'done';
    if (index === 1) return phase === 'sent' ? 'done' : 'active';
    return phase === 'sent' ? 'done' : '';
  };

  return (
    <>
      <ol className="steps">
        <li className={stepState(0)}>
          <span className="step-num">1</span>
          <span>
            تم تسجيل دخولك بحساب Google
            {bridgeSeen ? ' وإضافة المتصفح متصلة.' : '.'}
          </span>
        </li>
        <li className={stepState(1)}>
          <span className="step-num">2</span>
          <span>
            {phase === 'sent'
              ? 'تم إرسال الجلسة إلى الإضافة.'
              : 'جارٍ إرسال الجلسة إلى إضافة Facebook Post Saver…'}
          </span>
        </li>
        <li className={stepState(2)}>
          <span className="step-num">3</span>
          <span>افتح فيسبوك وابدأ حفظ المنشورات — ستنتقل تلقائيًا إلى مناقيش.</span>
        </li>
      </ol>

      {message && <div className={`notice ${phase === 'sent' ? '' : 'warn'}`} style={{ marginTop: 16 }}>{message}</div>}

      {phase !== 'sent' && (
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)} disabled={phase === 'sending'}>
            {phase === 'sending' ? 'جارٍ المحاولة…' : 'إعادة محاولة الربط'}
          </button>
          <a className="btn secondary" href="/">الذهاب إلى لوحة مناقيش</a>
        </div>
      )}

      {phase === 'sent' && (
        <div className="row" style={{ marginTop: 16 }}>
          <a className="btn" href="/">الذهاب إلى لوحة مناقيش</a>
          <a className="btn secondary" href="https://www.facebook.com" target="_blank" rel="noreferrer noopener">
            فتح فيسبوك
          </a>
        </div>
      )}

      <details style={{ marginTop: 18 }}>
        <summary>لم يعمل الربط؟</summary>
        <ul className="muted" style={{ marginTop: 8, paddingInlineStart: 20 }}>
          <li>تأكد أن إضافة <strong>Facebook Post Saver</strong> مثبّتة ومفعّلة في هذا المتصفح.</li>
          <li>افتح هذه الصفحة من متصفح Chrome أو Edge الذي ثبّتت عليه الإضافة.</li>
          <li>إن ظهرت لك رسالة أن حسابك غير مفعّل، فاطلب من مدير النظام تفعيله وتحديد دورك.</li>
          <li>بعد نجاح الربط تبقى الجلسة صالحة مدة طويلة وتُجدَّد تلقائيًا.</li>
        </ul>
      </details>
    </>
  );
}
