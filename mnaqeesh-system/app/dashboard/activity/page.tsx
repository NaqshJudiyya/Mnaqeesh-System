import { redirect } from 'next/navigation';
import { describeAccess, listActivity } from '@/lib/session';
import { canSeeActivityLog } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, string> = {
  'member.update': 'تحديث عضو',
  'post.update': 'تعديل منشور',
  'post.delete': 'حذف منشور',
  'translation.save': 'حفظ ترجمة',
  'translation.delete': 'حذف ترجمة',
  'language.add': 'إضافة لغة',
  'language.delete': 'حذف لغة'
};

export default async function ActivityPage() {
  const access = await describeAccess();
  if (access.state !== 'active') redirect('/login');
  if (!canSeeActivityLog(access.session.profile)) redirect('/not-authorized?reason=activity');

  const activity = await listActivity(80);

  return (
    <section className="card table-wrap">
      {activity.length === 0 ? (
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
