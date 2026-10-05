'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/auth-gate';
import { listActivity, type ClientActivityRow } from '@/lib/client/members';
import { canSeeActivityLog } from '@/lib/rbac';
import { appPath } from '@/lib/client/paths';

const ACTION_LABELS: Record<string, string> = {
  'member.update': 'تحديث عضو',
  'member.create': 'إضافة عضو',
  'member.set_password': 'تعيين كلمة مرور عضو',
  'member.switch_to': 'تبديل إلى حساب عضو',
  'member.switch_back': 'العودة للحساب الأصلي',
  'post.update': 'تعديل منشور',
  'post.delete': 'حذف منشور',
  'post.restore': 'استعادة منشور',
  'post.author_change': 'تغيير صاحب البوست',
  'post.content.edit': 'تعديل نص منشور',
  'post.content.reset': 'استعادة النص الأصلي',
  'posts.import': 'استيراد منشورات',
  'posts.bulk_status': 'تغيير حالة جماعي',
  'posts.bulk_delete': 'حذف جماعي',
  'posts.bulk_restore': 'استعادة جماعية',
  'posts.bulk_author': 'تغيير صاحب البوست جماعيًا',
  'translation.save': 'حفظ ترجمة',
  'translation.delete': 'حذف ترجمة',
  'language.add': 'إضافة لغة',
  'language.delete': 'حذف لغة',
  'settings.update': 'تحديث إعدادات المظهر'
};

/**
 * سجل النشاط — manager only. The audit log rows are read through the
 * manager's own JWT (`activity_log_select_admin` RLS policy).
 */
export default function ActivityPage() {
  const session = useSession();
  const router = useRouter();
  const [activity, setActivity] = useState<ClientActivityRow[] | null>(null);

  useEffect(() => {
    if (!session) return;
    if (!canSeeActivityLog(session.profile)) {
      router.replace(appPath('/not-authorized?reason=activity'));
      return;
    }

    let cancelled = false;
    (async () => {
      const rows = await listActivity(80);
      if (!cancelled) setActivity(rows);
    })();

    return () => {
      cancelled = true;
    };
  }, [session, router]);

  if (!session) return null;

  return (
    <section className="card table-wrap">
      {activity === null ? (
        <div className="empty">جارٍ تحميل السجل…</div>
      ) : activity.length === 0 ? (
        <div className="empty">لا يوجد نشاط مسجّل بعد.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>الوقت</th>
              <th>الإجراء</th>
              <th>المنفّذ</th>
              <th>التفاصيل</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((row) => (
              <tr key={row.id}>
                <td className="cell-muted">{new Date(row.created_at).toLocaleString('ar-EG')}</td>
                <td>
                  <span className="badge">{ACTION_LABELS[row.action] ?? row.action}</span>
                </td>
                <td>{row.actor_email || '—'}</td>
                <td className="cell-muted">
                  <code>{JSON.stringify(row.details)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
