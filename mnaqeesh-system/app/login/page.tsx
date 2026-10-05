'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { appPath } from '@/lib/client/paths';
import { waitForSession } from '@/lib/client/session';

/**
 * Members the manager created by hand sign in with a username, which the
 * server stored as `<username>@members.mnaqeesh.local`. Anything that is
 * not a real email address is treated as a username.
 */
const MEMBER_EMAIL_DOMAIN = 'members.mnaqeesh.local';

function resolveLoginEmail(input: string): string {
  const value = input.trim();
  if (!value) return '';
  return value.includes('@') ? value : `${value.toLowerCase()}@${MEMBER_EMAIL_DOMAIN}`;
}

/**
 * Only a real same-origin path — `//evil.com` is protocol-relative and
 * `/\evil.com` normalises the same way in browsers, so both are refused.
 */
function safeNextPath(next: string): string {
  return /^\/(?![/\\])/.test(next) ? next : '/dashboard';
}

function LoginForm() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';
  const urlError = params.get('error');

  const [mode, setMode] = useState<'google' | 'password'>('google');
  const [identifier, setIdentifier] = useState(params.get('u') ?? '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(urlError ?? '');

  // The OAuth return lands HERE (no server callback on a static host):
  // the browser client exchanges the PKCE code automatically, and this
  // effect notices the session and forwards to the destination.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await waitForSession();
      if (cancelled || !session) return;
      window.location.replace(appPath(safeNextPath(next)));
    })();
    return () => {
      cancelled = true;
    };
  }, [next]);

  async function signInWithGoogle() {
    setLoading(true);
    setError('');
    try {
      const supabase = createClient();
      // Static hosts serve the site from one origin; the PKCE code comes
      // back to /login and is exchanged in the browser (effect above).
      const callback = new URL(appPath('/login'), window.location.origin);
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callback.toString(),
          queryParams: { prompt: 'select_account' }
        }
      });
      if (authError) throw authError;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر بدء تسجيل الدخول.');
      setLoading(false);
    }
  }

  async function signInWithPassword() {
    setLoading(true);
    setError('');
    try {
      const email = resolveLoginEmail(identifier);
      if (!email) throw new Error('اكتب اسم المستخدم أو البريد.');

      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        throw new Error(
          /invalid login credentials/i.test(authError.message)
            ? 'اسم المستخدم أو كلمة المرور غير صحيحة.'
            : authError.message
        );
      }

      window.location.href = appPath(safeNextPath(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل الدخول.');
      setLoading(false);
    }
  }

  return (
    <section className="card login-card">
      <div className="logo">م</div>
      <h1>مناقيش</h1>
      <p>
        نظام مركزي يجمع منشورات فيسبوك التي يحفظها الفريق عبر إضافة
        <strong> Facebook Post Saver</strong>، مع إدارة كاملة للمنشورات والترجمات.
      </p>

      <div className="lang-chips" style={{ justifyContent: 'center', marginTop: 16 }}>
        <button
          type="button"
          className={`chip ${mode === 'google' ? 'active' : ''}`}
          onClick={() => { setMode('google'); setError(''); }}
        >
          حساب Google
        </button>
        <button
          type="button"
          className={`chip ${mode === 'password' ? 'active' : ''}`}
          onClick={() => { setMode('password'); setError(''); }}
        >
          اسم مستخدم وكلمة مرور
        </button>
      </div>

      {mode === 'google' ? (
        <>
          <button className="google-btn" onClick={signInWithGoogle} disabled={loading}>
            {loading ? 'جارٍ فتح تسجيل الدخول…' : 'تسجيل الدخول باستخدام Google'}
          </button>

          <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>
            الدخول متاح فقط للحسابات التي فعّلها مدير النظام. إن سجّلت الدخول ولم تتمكن من المتابعة،
            فراسل المدير لتفعيل حسابك وتحديد دورك.
          </p>
        </>
      ) : (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <div className="field">
            <label htmlFor="lg-user">اسم المستخدم أو البريد</label>
            <input
              id="lg-user"
              className="input"
              style={{ width: '100%' }}
              dir="ltr"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="ahmed.ali"
            />
          </div>

          <div className="field">
            <label htmlFor="lg-pass">كلمة المرور</label>
            <input
              id="lg-pass"
              className="input"
              style={{ width: '100%' }}
              dir="ltr"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && identifier && password) void signInWithPassword();
              }}
            />
          </div>

          <button
            className="google-btn"
            style={{ marginTop: 4 }}
            onClick={signInWithPassword}
            disabled={loading || !identifier || !password}
          >
            {loading ? 'جارٍ الدخول…' : 'تسجيل الدخول'}
          </button>

          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            هذه البيانات يعطيك إياها مدير النظام إذا أنشأ حسابك يدويًا.
          </p>
        </div>
      )}

      {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
    </section>
  );
}

export default function LoginPage() {
  return (
    <main className="login-shell">
      <Suspense fallback={<section className="card login-card"><p>جارٍ التحميل…</p></section>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
