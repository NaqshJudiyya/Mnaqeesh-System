'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth-gate';
import PostsClient from '@/components/posts-client';
import LanguageExportPanel from '@/components/language-export-panel';
import { getDashboardStats, listLanguages, translationCountsByLanguage } from '@/lib/client/posts';
import { listMembers } from '@/lib/client/members';
import { canSeeMembers } from '@/lib/rbac';
import type { LanguageRow } from '@/lib/types';
import type { DashboardStats } from '@/lib/client/posts';
import type { MemberRow } from '@/lib/client/members';

/**
 * لوحة المنشورات — the old server component's data fetches now run in
 * the browser through RLS. The member list is only requested by the
 * manager (RLS would hide it from everyone else anyway).
 */
export default function DashboardPage() {
  const session = useSession();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [languages, setLanguages] = useState<LanguageRow[]>([]);
  const [translationCounts, setTranslationCounts] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!session) return;
    const { profile } = session;
    const isManager = canSeeMembers(profile);

    let cancelled = false;
    (async () => {
      try {
        const [statsResult, languagesResult, countsResult, membersResult] = await Promise.all([
          getDashboardStats(profile),
          listLanguages(),
          translationCountsByLanguage(),
          isManager ? listMembers().catch(() => []) : Promise.resolve([])
        ]);
        if (cancelled) return;
        setStats(statsResult);
        setLanguages(languagesResult);
        setTranslationCounts(countsResult);
        setMembers(membersResult);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'تعذر تحميل لوحة البيانات.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return null;

  const memberOptions = members.map((member) => ({
    id: member.id,
    full_name: member.full_name,
    email: member.email
  }));

  return (
    <>
      {loadError && <div className="notice error">{loadError}</div>}

      <Kpis stats={stats} isManager={canSeeMembers(session.profile)} profile={session.profile} />

      <LanguageExportPanel
        viewer={session.profile}
        languages={languages}
        translationCounts={translationCounts}
        totalPosts={stats?.totalPosts ?? 0}
        members={memberOptions}
        canPickMember={canSeeMembers(session.profile)}
      />

      <PostsClient
        viewer={session.profile}
        members={memberOptions}
        languages={languages}
        translationCounts={translationCounts}
      />
    </>
  );
}

function Kpis({
  stats,
  isManager,
  profile
}: {
  stats: DashboardStats | null;
  isManager: boolean;
  profile: { role: string };
}) {
  if (!stats) {
    return (
      <section className="kpis">
        <div className="card kpi">
          <div className="kpi-label">جارٍ تحميل الأرقام…</div>
        </div>
      </section>
    );
  }

  return (
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
          <div className="kpi-note">الدور والصلاحيات يحددها مدير النظام</div>
        </div>
      )}
    </section>
  );
}
