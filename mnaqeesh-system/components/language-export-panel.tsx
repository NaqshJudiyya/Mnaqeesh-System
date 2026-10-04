'use client';

import { useMemo, useState } from 'react';
import type { LanguageRow } from '@/lib/types';
import type { Profile } from '@/lib/rbac';
import { runExport } from '@/lib/client/export';

type Member = { id: string; full_name: string; email: string };

type Props = {
  viewer: Profile;
  languages: LanguageRow[];
  translationCounts: Record<string, number>;
  totalPosts: number;
  members: Member[];
  /** True for the manager, the only role that may filter by member. */
  canPickMember: boolean;
};

const FORMATS: { value: 'xlsx' | 'csv' | 'json' | 'markdown' | 'wxr'; label: string; ext: string }[] = [
  { value: 'xlsx', label: 'Excel', ext: 'xlsx' },
  { value: 'csv', label: 'CSV', ext: 'csv' },
  { value: 'json', label: 'JSON', ext: 'json' },
  { value: 'markdown', label: 'Markdown', ext: 'md' },
  { value: 'wxr', label: 'WordPress', ext: 'xml' }
];

const GROUPINGS: { value: 'all' | 'year' | 'month' | 'account'; label: string; hint: string }[] = [
  { value: 'all', label: 'ملف واحد — الكل', hint: 'كل المنشورات في ملف واحد' },
  { value: 'year', label: 'ملف لكل سنة', hint: 'ملف مستقل لكل سنة' },
  { value: 'month', label: 'ملف لكل شهر', hint: 'ملف مستقل لكل شهر' },
  { value: 'account', label: 'ملف لكل حساب', hint: 'ملف مستقل لكل عضو' }
];

/** Quick date-range presets, mapped onto the from/to filters. */
const PERIODS: { value: string; label: string }[] = [
  { value: '', label: 'كل الفترات' },
  { value: 'this-year', label: 'هذه السنة' },
  { value: 'this-year-last', label: 'السنة الماضية' },
  { value: 'this-month', label: 'هذا الشهر' },
  { value: 'last-30', label: 'آخر 30 يومًا' },
  { value: 'last-90', label: 'آخر 90 يومًا' },
  { value: 'custom', label: 'فترة مخصصة…' }
];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Turns a preset into the `from`/`to` pair the export understands. */
function periodRange(preset: string, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case 'this-year':
      return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    case 'this-year-last':
      return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
    case 'this-month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: isoDate(first), to: isoDate(last) };
    }
    case 'last-30': {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: isoDate(start), to: isoDate(now) };
    }
    case 'last-90': {
      const start = new Date(now);
      start.setDate(start.getDate() - 90);
      return { from: isoDate(start), to: isoDate(now) };
    }
    case 'custom':
      return { from: customFrom, to: customTo };
    default:
      return { from: '', to: '' };
  }
}

/**
 * Export builder.
 *
 * Combines four independent choices:
 *   1. WHO  — everyone, or one member
 *   2. WHEN — a preset range or a custom one
 *   3. WHAT — one language only (or the Arabic source)
 *   4. HOW  — a single file, or one file per year / month / account
 *
 * The files are built IN THE BROWSER from rows fetched through RLS and
 * downloaded directly — a split export is zipped client-side.
 */
export default function LanguageExportPanel({
  viewer,
  languages,
  translationCounts,
  totalPosts,
  members,
  canPickMember
}: Props) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('source');
  const [owner, setOwner] = useState('');
  const [group, setGroup] = useState<'all' | 'year' | 'month' | 'account'>('all');
  const [period, setPeriod] = useState('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const { from, to } = periodRange(period, customFrom, customTo);

  const languageRows = useMemo(
    () => [
      { code: 'source', name: 'العربية (الأصلية)', count: totalPosts },
      ...languages.map((language) => ({
        code: language.code,
        name: language.name_ar || language.name_en || language.code,
        count: translationCounts[language.code] ?? 0
      }))
    ],
    [languages, translationCounts, totalPosts]
  );

  const selected = languageRows.find((row) => row.code === scope) ?? languageRows[0];
  const groupHint = GROUPINGS.find((item) => item.value === group)?.hint ?? '';
  const willZip = group !== 'all';
  const selectedOwner = members.find((member) => member.id === owner);

  async function download(format: (typeof FORMATS)[number]['value']) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const outcome = await runExport({
        profile: viewer,
        format,
        scope,
        owner: canPickMember ? owner || undefined : undefined,
        group,
        from: from || undefined,
        to: to || undefined,
        languageName: (code: string) => {
          const language = languages.find((item) => item.code === code);
          return language ? language.name_ar || language.name_en || code : code.toUpperCase();
        }
      });
      setNotice(`تم توليد ${outcome.filename} (${outcome.count} منشورًا) وتنزيله.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إنشاء ملف التصدير.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card panel export-panel" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>📤 التصدير</h2>
          <p className="muted" style={{ margin: 0 }}>
            اختر <strong>لمن</strong> و<strong>لأي فترة</strong> و<strong>أي لغة</strong>، ثم قسّم الملفات
            حسب السنة أو الشهر أو الحساب — الملف يُبنى في متصفحك ثم يُنزَّل مباشرة.
          </p>
        </div>
        <button className="btn secondary small" onClick={() => setOpen((value) => !value)}>
          {open ? 'إخفاء الخيارات' : 'إظهار الخيارات'}
        </button>
      </div>

      {error && <div className="notice error" style={{ marginTop: 10 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginTop: 10 }}>{notice}</div>}

      {open && (
        <>
          {/* ---------------- 1. who ---------------- */}
          <div className="export-step">
            <div className="export-step-title"><span className="step-badge">1</span> لمن؟</div>
            {canPickMember ? (
              <select
                className="select grow"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                aria-label="اختيار العضو"
              >
                <option value="">كل الأعضاء</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.full_name || member.email}
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted" style={{ margin: 0 }}>تُصدَّر منشوراتك فقط.</p>
            )}
          </div>

          {/* ---------------- 2. when ---------------- */}
          <div className="export-step">
            <div className="export-step-title"><span className="step-badge">2</span> لأي فترة؟</div>
            <select
              className="select grow"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              aria-label="الفترة الزمنية"
            >
              {PERIODS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>

            {period === 'custom' && (
              <div className="row" style={{ marginTop: 8 }}>
                <label className="field-inline">
                  <span>من</span>
                  <input
                    type="date"
                    className="input"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                </label>
                <label className="field-inline">
                  <span>إلى</span>
                  <input
                    type="date"
                    className="input"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </label>
              </div>
            )}

            <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>
              الفترة تُطبَّق على <strong>وقت الحفظ في النظام</strong>.
            </p>
          </div>

          {/* ---------------- 3. language ---------------- */}
          <div className="export-step">
            <div className="export-step-title"><span className="step-badge">3</span> أي لغة؟</div>
            <div className="lang-chips">
              {languageRows.map((row) => (
                <button
                  key={row.code}
                  type="button"
                  className={`chip ${scope === row.code ? 'active' : ''} ${row.count > 0 ? 'has-translation' : ''}`}
                  onClick={() => setScope(row.code)}
                >
                  {row.name}
                  <span style={{ opacity: 0.75 }}>({row.count})</span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>
              كل لغة تُصدَّر منفصلة تمامًا — والمنشور الذي لا ترجمة له بهذه اللغة يُستثنى.
            </p>
          </div>

          {/* ---------------- 4. grouping ---------------- */}
          <div className="export-step">
            <div className="export-step-title"><span className="step-badge">4</span> كيف تُقسَّم الملفات؟</div>
            <div className="lang-chips">
              {GROUPINGS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`chip ${group === item.value ? 'active' : ''}`}
                  onClick={() => setGroup(item.value)}
                  title={item.hint}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* ---------------- summary + download ---------------- */}
          <div className="export-summary">
            <div className="export-summary-lines">
              <div>
                <span>النطاق</span>
                <strong>{selectedOwner ? selectedOwner.full_name || selectedOwner.email : 'كل الأعضاء'}</strong>
              </div>
              <div>
                <span>الفترة</span>
                <strong dir="ltr">{from || to ? `${from || '…'} → ${to || '…'}` : 'الكل'}</strong>
              </div>
              <div>
                <span>اللغة</span>
                <strong>{selected?.name}</strong>
              </div>
              <div>
                <span>التقسيم</span>
                <strong>{GROUPINGS.find((item) => item.value === group)?.label}</strong>
              </div>
            </div>

            {selected && selected.count === 0 ? (
              <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
                لا توجد محتويات بهذه اللغة بعد.
              </div>
            ) : (
              <>
                <div className="row" style={{ marginTop: 12 }}>
                  {FORMATS.map((format) => (
                    <button
                      key={format.value}
                      type="button"
                      className="btn secondary small export-btn"
                      disabled={busy}
                      onClick={() => void download(format.value)}
                    >
                      <span>{format.label}</span>
                      <em>.{willZip ? 'zip' : format.ext}</em>
                    </button>
                  ))}
                </div>

                <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
                  {busy ? (
                    <>جارٍ توليد الملف في المتصفح… قد يستغرق لحظات مع الأرشيف الكبير.</>
                  ) : willZip ? (
                    <>
                      سيتم تنزيل <strong>ملف ZIP</strong> يحتوي {groupHint}، وكل ملف بداخله بصيغة{' '}
                      {FORMATS.map((f) => f.label).join(' / ')} حسب الزر الذي تضغطه.
                    </>
                  ) : (
                    <>سيتم تنزيل ملف واحد يحتوي كل المنشورات المطابقة.</>
                  )}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
