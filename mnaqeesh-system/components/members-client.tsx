'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ROLE_LABELS,
  ROLE_SHORT_LABELS,
  STATUS_LABELS,
  type Profile,
  type Role,
  type Status
} from '@/lib/rbac';
import Modal from '@/components/modal';

type Member = Profile & { post_count?: number };

type Props = {
  currentUserId: string;
  initialMembers: Member[];
  /** True when this session was entered through "switch account". */
  isImpersonating: boolean;
  /** Email of the account this session switched away from, when known. */
  originEmail: string;
};

export default function MembersClient({
  currentUserId,
  initialMembers,
  isImpersonating,
  originEmail
}: Props) {
  const router = useRouter();
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'all' | Status>('all');

  // Create-member form
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('collector');
  const [createBusy, setCreateBusy] = useState(false);
  const [createdLogin, setCreatedLogin] = useState<{ email: string; password: string } | null>(null);

  // Switch-account modal
  const [switchTarget, setSwitchTarget] = useState<Member | null>(null);
  const [switchPassword, setSwitchPassword] = useState('');
  const [switchBusy, setSwitchBusy] = useState(false);

  async function update(memberId: string, patch: { role?: Role; status?: Status }) {
    setBusyId(memberId);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'تعذر تحديث العضو.');

      setMembers((current) =>
        current.map((member) => (member.id === memberId ? { ...member, ...payload.member } : member))
      );
      setNotice('تم تحديث بيانات العضو.');
      // The KPI cards are rendered on the server, so refresh their numbers.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث العضو.');
    } finally {
      setBusyId('');
    }
  }

  async function createMember() {
    setCreateBusy(true);
    setError('');
    setNotice('');
    setCreatedLogin(null);
    try {
      const response = await fetch('/api/members/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername,
          fullName: newFullName,
          password: newPassword,
          role: newRole,
          status: 'active'
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'تعذر إنشاء العضو.');

      setCreatedLogin({ email: payload.member.email, password: newPassword });
      setNotice(`تم إنشاء العضو ${payload.member.full_name}. سلّمه بيانات الدخول أدناه.`);
      setNewUsername('');
      setNewFullName('');
      setNewPassword('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إنشاء العضو.');
    } finally {
      setCreateBusy(false);
    }
  }

  async function doSwitch() {
    if (!switchTarget) return;
    setSwitchBusy(true);
    setError('');
    try {
      const response = await fetch('/api/members/switch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUserId: switchTarget.id,
          password: switchPassword,
          owner: currentUserId
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'تعذر تبديل الحساب.');
      // Full reload so the server components pick up the new session.
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تبديل الحساب.');
      setSwitchBusy(false);
    }
  }

  async function switchBack() {
    setError('');
    try {
      const response = await fetch('/api/members/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: currentUserId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'تعذر العودة للحساب الأصلي.');
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر العودة للحساب الأصلي.');
    }
  }

  const visible = filter === 'all' ? members : members.filter((member) => member.status === filter);

  const counts = {
    all: members.length,
    active: members.filter((m) => m.status === 'active').length,
    pending: members.filter((m) => m.status === 'pending').length,
    disabled: members.filter((m) => m.status === 'disabled').length
  };

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {isImpersonating && (
        <div className="notice warn">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              أنت داخل حساب عضو آخر
              {originEmail ? <> (الحساب الأصلي: <strong dir="ltr">{originEmail}</strong>)</> : null}.
            </span>
            <button className="btn small" onClick={switchBack}>↩ العودة لحسابي</button>
          </div>
        </div>
      )}

      <section className="card toolbar">
        <div className="lang-chips">
          {(['all', 'active', 'pending', 'disabled'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`chip ${filter === key ? 'active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {key === 'all' ? 'الكل' : STATUS_LABELS[key]}
              <span style={{ opacity: 0.75 }}>({counts[key]})</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => { setShowCreate(true); setCreatedLogin(null); }}>
          + إضافة عضو يدويًا
        </button>
      </section>

      <section className="card table-wrap">
        {visible.length === 0 ? (
          <div className="empty">لا يوجد أعضاء بهذه الحالة.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>العضو</th>
                <th>الحالة</th>
                <th>الدور</th>
                <th>المنشورات</th>
                <th>تغيير الدور</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((member) => {
                const isSelf = member.id === currentUserId;
                const busy = busyId === member.id;

                return (
                  <tr key={member.id}>
                    <td>
                      <div className="cell-title">
                        {member.full_name || 'بدون اسم'}
                        {isSelf && <span className="muted"> (أنت)</span>}
                      </div>
                      <div className="cell-muted" dir="ltr">{member.email}</div>
                    </td>
                    <td>
                      <span className={`badge ${member.status}`}>{STATUS_LABELS[member.status]}</span>
                    </td>
                    <td>
                      <span className={`badge role-${member.role}`}>{ROLE_SHORT_LABELS[member.role]}</span>
                    </td>
                    <td className="cell-muted">{member.post_count ?? 0}</td>
                    <td>
                      <select
                        className="select"
                        value={member.role}
                        disabled={busy || isSelf}
                        onChange={(event) => update(member.id, { role: event.target.value as Role })}
                      >
                        {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                          <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="actions">
                        {member.status !== 'active' && (
                          <button className="btn small" disabled={busy || isSelf} onClick={() => update(member.id, { status: 'active' })}>
                            تفعيل
                          </button>
                        )}
                        {member.status === 'active' && (
                          <button className="btn danger small" disabled={busy || isSelf} onClick={() => update(member.id, { status: 'disabled' })}>
                            تعطيل
                          </button>
                        )}
                        {!isSelf && (
                          <button
                            className="btn secondary small"
                            disabled={busy}
                            title="الدخول بحساب هذا العضو"
                            onClick={() => { setSwitchTarget(member); setSwitchPassword(''); setError(''); }}
                          >
                            ⇄ تبديل
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card panel" style={{ marginTop: 16 }}>
        <h2>صلاحيات الأدوار</h2>
        <ul className="meta-list">
          <li><span>مدير</span><span>يطلع على كل شيء ويتحكم في كل شيء، بما في ذلك الأعضاء والصلاحيات واللغات، ويستطيع التبديل بين الحسابات.</span></li>
          <li><span>محرر</span><span>يدخل النظام ويتحكم في كل المحتوى، ولا يتحكم في الصلاحيات ولا يضيف أعضاء ولا يرى قائمة الأعضاء.</span></li>
          <li><span>مستخدم</span><span>يحمّل الإضافة ويسجّل دخوله، ويحفظ المنشورات، ويعدّل فقط المنشورات التي حفظها بنفسه.</span></li>
          <li><span>مترجم</span><span>يدخل النظام ويضيف ترجمات بلغات متعددة لكل منشور، ولا يرى الأعضاء ولا يتحكم في الصلاحيات.</span></li>
        </ul>
      </section>

      {/* ---------------- create member ---------------- */}
      <Modal
        open={showCreate}
        title="إضافة عضو يدويًا"
        subtitle="أنشئ الحساب وسلّم بيانات الدخول للعضو مباشرة — لا حاجة لانتظار تسجيله بنفسه."
        onClose={() => setShowCreate(false)}
      >
        <div className="field">
          <label htmlFor="nm-username">اسم المستخدم للإضافة (إنجليزي)</label>
          <input
            id="nm-username"
            className="input"
            style={{ width: '100%' }}
            dir="ltr"
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            placeholder="ahmed.ali"
            maxLength={32}
          />
          <p className="muted" style={{ marginBottom: 0 }}>
            يُستخدم لتسجيل الدخول داخل الإضافة. حروف إنجليزية وأرقام ونقطة أو شرطة (3–32 حرفًا).
          </p>
        </div>

        <div className="field">
          <label htmlFor="nm-name">الاسم الظاهر</label>
          <input
            id="nm-name"
            className="input"
            style={{ width: '100%' }}
            value={newFullName}
            onChange={(event) => setNewFullName(event.target.value)}
            placeholder="أحمد علي"
            maxLength={120}
          />
        </div>

        <div className="field">
          <label htmlFor="nm-pass">كلمة المرور</label>
          <input
            id="nm-pass"
            className="input"
            style={{ width: '100%' }}
            dir="ltr"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="8 أحرف على الأقل"
          />
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="nm-role">الدور</label>
          <select
            id="nm-role"
            className="select"
            style={{ width: '100%' }}
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as Role)}
          >
            {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
              <option key={role} value={role}>{ROLE_LABELS[role]}</option>
            ))}
          </select>
        </div>

        {createdLogin && (
          <div className="notice" style={{ marginTop: 14 }}>
            <strong>بيانات الدخول للعضو:</strong>
            <div className="credentials">
              <div><span>المستخدم</span><code dir="ltr">{createdLogin.email}</code></div>
              <div><span>كلمة المرور</span><code dir="ltr">{createdLogin.password}</code></div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              انسخها الآن وسلّمها للعضو — لن تُعرض مرة أخرى.
            </p>
          </div>
        )}

        <div className="modal-foot" style={{ margin: '16px -18px -16px', borderRadius: '0 0 14px 14px' }}>
          <button className="btn secondary" onClick={() => setShowCreate(false)}>إغلاق</button>
          <button
            className="btn"
            onClick={createMember}
            disabled={createBusy || !newUsername.trim() || newPassword.length < 8}
          >
            {createBusy ? 'جارٍ الإنشاء…' : 'إنشاء العضو'}
          </button>
        </div>
      </Modal>

      {/* ---------------- switch account ---------------- */}
      <Modal
        open={switchTarget !== null}
        title="تبديل الحساب"
        subtitle={switchTarget ? `الدخول بحساب ${switchTarget.full_name || switchTarget.email}` : undefined}
        onClose={() => setSwitchTarget(null)}
      >
        <div className="notice warn">
          أدخل كلمة مرور هذا العضو للدخول بحسابه. الأعضاء الذين دخلوا بحساب Google ليس لهم كلمة مرور،
          لذا يلزم تعيين كلمة مرور لهم أولًا.
        </div>

        <div className="field">
          <label htmlFor="sw-pass">كلمة مرور العضو</label>
          <input
            id="sw-pass"
            className="input"
            style={{ width: '100%' }}
            dir="ltr"
            value={switchPassword}
            onChange={(event) => setSwitchPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && switchPassword) void doSwitch();
            }}
          />
        </div>

        <p className="muted" style={{ marginBottom: 0 }}>
          يمكنك العودة لحسابك من نفس هذه الصفحة بزر <strong>«↩ العودة لحسابي»</strong> بدون إدخال كلمة مرور.
        </p>

        <div className="modal-foot" style={{ margin: '16px -18px -16px', borderRadius: '0 0 14px 14px' }}>
          <button className="btn secondary" onClick={() => setSwitchTarget(null)}>إلغاء</button>
          <button className="btn" onClick={doSwitch} disabled={switchBusy || !switchPassword}>
            {switchBusy ? 'جارٍ التبديل…' : 'دخول بهذا الحساب'}
          </button>
        </div>
      </Modal>
    </>
  );
}
