import { redirect } from 'next/navigation';
import { describeAccess, listMembers } from '@/lib/session';
import { getDashboardStats, listLanguages, translationCountsByLanguage } from '@/lib/data';
import { canSeeMembers } from '@/lib/rbac';
import PostsClient from '@/components/posts-client';
import LanguageExportPanel from '@/components/language-export-panel';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const access = await describeAccess();
  if (access.state !== 'active') redirect('/login');

  const { profile } = access.session;
  const isManager = canSeeMembers(profile);

  const [stats, languages, translationCounts, members] = await Promise.all([
    getDashboardStats(profile),
    listLanguages(),
    translationCountsByLanguage(),
    // Only the manager may enumerate members; everyone else gets nothing.
    isManager ? listMembers() : Promise.resolve([])
  ]);

  const memberOptions = members.map((member) => ({
    id: member.id,
    full_name: member.full_name,
    email: member.email
  }));

  return (
    <>
      <section className="kpis">
        <div className="card kpi">
          <div className="kpi-label">المنشورات المحفوظة</div>
          <div className="kpi-value">{stats.totalPosts}</div>
          <div className="kpi-note">
            {profile.role === 'collector' ? 'المنشورات التي حفظتها أنت' : 'إجمالي ما حفظه الفريق'}
          </div>
        </div>

        <div className="card kpi">
          <div className="kpi-label">منشورات مترجَمة</div>
          <div className="kpi-value">{stats.translatedPosts}</div>
          <div className="kpi-note">منشورات لها ترجمة واحدة على الأقل</div>
        </div>

        <div className="card kpi">
          <div className="kpi-label">لغات الترجمة</div>
          <div className="kpi-value">{stats.languageCount}</div>
          <div className="kpi-note">تُضاف لغة جديدة من داخل أي منشور</div>
        </div>

        {isManager ? (
          <div className="card kpi">
            <div className="kpi-label">الأعضاء</div>
            <div className="kpi-value">{stats.activeMembers}</div>
            <div className="kpi-note">
              {stats.pendingMembers > 0
                ? `${stats.pendingMembers} حساب بانتظار التفعيل`
                : 'لا توجد حسابات بانتظار التفعيل'}
            </div>
          </div>
        ) : (
          <div className="card kpi">
            <div className="kpi-label">حالة الحساب</div>
            <div className="kpi-value">نشط</div>
            <div className="kpi-note">الدور والصلاحيات يحددهما مدير النظام</div>
          </div>
        )}
      </section>

      <LanguageExportPanel
        languages={languages}
        translationCounts={translationCounts}
        totalPosts={stats.totalPosts}
        members={memberOptions}
        canPickMember={isManager}
      />

      <PostsClient
        viewer={profile}
        members={memberOptions}
        languages={languages}
        translationCounts={translationCounts}
      />
    </>
  );
}
