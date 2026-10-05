'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { describeAccess } from '@/lib/client/session';
import { ROLE_SHORT_LABELS, STATUS_LABELS } from '@/lib/rbac';
import type { Profile } from '@/lib/rbac';

const REASONS: Record<string, { title: string; body: string }> = {
  pending: {
    title: 'حسابك بانتظار التفعيل',
    body: 'تم إنشاء حسابك بنجاح، لكن مدير النظام لم يفعّله بعد. تواصل معه لتفعيل حسابك وتحديد دورك، ثم أعد المحاولة.'
  },
  disabled: {
    title: 'حسابك معطّل',
    body: 'قام مدير النظام بتعطيل هذا الحساب. تواصل معه لمعرفة السبب وإعادة التفعيل.'
  },
  no_profile: {
    title: 'لا يوجد ملف تعريف لهذا الحساب',
    body: 'سجّل دخولك من جديد. إن استمرت المشكلة فراسل مدير النظام ليُنشئ ملفك داخل النظام.'
  },
  members: {
    title: 'غير مسموح بالاطلاع على الأعضاء',
    body: 'هذه الصفحة متاحة لمدير النظام فقط. دورك الحالي يمنع عرض الأعضاء الآخرين.'
  },
  activity: {
    title: 'غير مسموح بالاطلاع على السجل',
    body: 'سجل النشاط متاح لمدير النظام فقط.'
  },
  settings: {
    title: 'غير مسموح بتعديل إعدادات الموقع',
    body: 'إعدادات تنسيق الموقع (الألوان والخطوط والجداول) متاحة لمدير النظام فقط، لأنها تسري على كل الأعضاء.'
  }
};

function NotAuthorizedContent() {
  const params = useSearchParams();
  const reason = params.get('reason') ?? '';
  const info = REASONS[reason] ?? {
    title: 'لا تملك صلاحية الوصول',
    body: 'هذا الحساب غير مصرّح له باستخدام النظام حاليًا. تواصل مع مدير النظام.'
  };

  const [identity, setIdentity] = useState<Profile | null>(null);

  // Reads the member's own row through RLS just to display it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await describeAccess();
        if (cancelled) return;
        if (access.state === 'active') setIdentity(access.session.profile);
        else if (access.state === 'pending' || access.state === 'disabled') setIdentity(access.profile);
      } catch {
        // The explanation text stands on its own without the identity block.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card login-card">
      <div className="logo">م</div>
      <h1 style={{ fontSize: 19 }}>{info.title}</h1>
      <p>{info.body}</p>

      {identity && (
        <ul className="meta-list" style={{ textAlign: 'right', marginTop: 16 }}>
          <li><span>البريد</span><span>{identity.email}</span></li>
          <li><span>الحالة</span><span>{STATUS_LABELS[identity.status]}</span></li>
          <li><span>الدور</span><span>{ROLE_SHORT_LABELS[identity.role]}</span></li>
        </ul>
      )}

      <div className="row" style={{ marginTop: 20, justifyContent: 'center' }}>
        <Link className="btn secondary" href="/login">تسجيل الدخول بحساب آخر</Link>
      </div>
    </section>
  );
}

export default function NotAuthorizedPage() {
  return (
    <main className="login-shell">
      <Suspense fallback={<section className="card login-card"><p>جارٍ التحميل…</p></section>}>
        <NotAuthorizedContent />
      </Suspense>
    </main>
  );
}
