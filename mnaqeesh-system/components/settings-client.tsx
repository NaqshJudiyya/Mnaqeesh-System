'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_APPEARANCE,
  FONT_OPTIONS,
  appearanceCssVars,
  type AppearanceSettings
} from '@/lib/appearance';
import { saveAppearance } from '@/lib/client/settings';
import type { Profile } from '@/lib/rbac';

type Props = {
  initial: AppearanceSettings;
  viewer: Profile;
};

type ColorField = {
  key: 'primaryColor' | 'primaryDarkColor' | 'accentColor' | 'bgColor' | 'textColor';
  label: string;
  hint: string;
};

const COLOR_FIELDS: ColorField[] = [
  { key: 'primaryColor', label: 'اللون الأساسي', hint: 'الأزرار والروابط والشرائح النشطة' },
  { key: 'primaryDarkColor', label: 'اللون الأساسي الغامق', hint: 'العناوين وحالة التحويم' },
  { key: 'accentColor', label: 'لون التمييز (ذهبي)', hint: 'حدود بطاقات الترجمة والاقتباسات' },
  { key: 'bgColor', label: 'لون خلفية الصفحة', hint: 'خلفية الموقع خلف البطاقات' },
  { key: 'textColor', label: 'لون النص', hint: 'لون النص الأساسي في كل الصفحات' }
];

type NumberField = {
  key: 'baseFontSize' | 'tableFontSize' | 'cellPaddingX' | 'cellPaddingY' | 'textCellWidth' | 'textCellHeight';
  label: string;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  hint: string;
};

const NUMBER_FIELDS: NumberField[] = [
  {
    key: 'baseFontSize',
    label: 'حجم خط الموقع',
    min: 12,
    max: 20,
    step: 0.5,
    suffix: 'px',
    hint: 'الحجم الأساسي للنصوص في كل الصفحات'
  },
  {
    key: 'tableFontSize',
    label: 'حجم خط الجدول',
    min: 11,
    max: 18,
    step: 0.5,
    suffix: 'px',
    hint: 'حجم النص داخل جدول المنشورات'
  },
  {
    key: 'cellPaddingX',
    label: 'عرض الخلية (التباعد الأفقي)',
    min: 2,
    max: 28,
    suffix: 'px',
    hint: 'المسافة الأفقية داخل خلايا الجدول — كلما زاد اتسع العرض'
  },
  {
    key: 'cellPaddingY',
    label: 'ارتفاع الخلية (التباعد الرأسي)',
    min: 2,
    max: 28,
    suffix: 'px',
    hint: 'المسافة الرأسية داخل خلايا الجدول — كلما زاد ارتفعت الصفوف'
  },
  {
    key: 'textCellWidth',
    label: 'أقصى عرض لخلية النص',
    min: 180,
    max: 900,
    suffix: 'px',
    hint: 'عرض عمود نص المنشور في الجدول'
  },
  {
    key: 'textCellHeight',
    label: 'أقصى ارتفاع لخلية النص',
    min: 40,
    max: 400,
    suffix: 'px',
    hint: 'عدد الأسطر الظاهرة من نص المنشور قبل الاقتطاع'
  }
];

/**
 * لوحة إعدادات مظهر النظام.
 *
 * Every change is applied live to the page through the same CSS custom
 * properties the server injects, so the manager sees exactly what the
 * site will look like BEFORE saving. Nothing is persisted until «حفظ».
 */
export default function SettingsClient({ initial, viewer }: Props) {
  const router = useRouter();
  const [settings, setSettings] = useState<AppearanceSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Live preview: the same variables the root layout renders server-side.
  useEffect(() => {
    const vars = appearanceCssVars(settings);
    const root = document.documentElement;
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
    return () => {
      // Leaving the page without saving restores the saved theme; the
      // next server render would do this anyway.
      for (const name of Object.keys(vars)) {
        root.style.removeProperty(name);
      }
    };
  }, [settings]);

  function update<K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setNotice('');
    setError('');
  }

  async function save(next: AppearanceSettings = settings) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await saveAppearance(viewer, next);
      setNotice('تم حفظ الإعدادات وصارت سارية على كل الموقع.');
      // Adopt the server-validated values as the new baseline.
      setSettings(saved);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ الإعدادات.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card panel">
        <h2>الألوان</h2>
        <p className="muted" style={{ marginTop: -6 }}>
          تغيّر الألوان تُطبَّق فورًا للمعاينة، ولا تُثبَّت إلا عند الحفظ.
        </p>
        <div className="settings-grid">
          {COLOR_FIELDS.map((field) => (
            <div key={field.key} className="field">
              <label htmlFor={`set-${field.key}`}>{field.label}</label>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input
                  id={`set-${field.key}`}
                  type="color"
                  className="color-input"
                  value={settings[field.key]}
                  onChange={(event) => update(field.key, event.target.value)}
                  aria-label={field.label}
                />
                <input
                  className="input"
                  dir="ltr"
                  style={{ width: 110 }}
                  value={settings[field.key]}
                  onChange={(event) => {
                    const value = event.target.value.startsWith('#')
                      ? event.target.value
                      : `#${event.target.value}`;
                    update(field.key, value);
                  }}
                  maxLength={7}
                />
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>{field.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card panel">
        <h2>الخطوط</h2>
        <div className="settings-grid">
          <div className="field">
            <label htmlFor="set-font">نوع الخط</label>
            <select
              id="set-font"
              className="select"
              style={{ width: '100%' }}
              value={settings.fontFamily}
              onChange={(event) => update('fontFamily', event.target.value)}
            >
              {FONT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {NUMBER_FIELDS.filter((field) => field.key === 'baseFontSize' || field.key === 'tableFontSize').map(
            (field) => (
              <div key={field.key} className="field">
                <label htmlFor={`set-${field.key}`}>
                  {field.label} <span className="muted">({settings[field.key]}{field.suffix})</span>
                </label>
                <input
                  id={`set-${field.key}`}
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={settings[field.key]}
                  onChange={(event) => update(field.key, Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
            )
          )}
        </div>
      </section>

      <section className="card panel">
        <h2>خلايا الجدول</h2>
        <div className="settings-grid">
          {NUMBER_FIELDS.filter(
            (field) =>
              field.key === 'cellPaddingX' ||
              field.key === 'cellPaddingY' ||
              field.key === 'textCellWidth' ||
              field.key === 'textCellHeight'
          ).map((field) => (
            <div key={field.key} className="field">
              <label htmlFor={`set-${field.key}`}>
                {field.label} <span className="muted">({settings[field.key]}{field.suffix})</span>
              </label>
              <input
                id={`set-${field.key}`}
                type="range"
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                value={settings[field.key]}
                onChange={(event) => update(field.key, Number(event.target.value))}
                style={{ width: '100%' }}
              />
              <p className="muted" style={{ marginBottom: 0 }}>{field.hint}</p>
            </div>
          ))}
        </div>

        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="posts-table">
            <thead>
              <tr>
                <th>الحساب</th>
                <th>النص</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div className="cell-title">معاينة</div>
                  <div className="cell-muted">حساب فيسبوك</div>
                </td>
                <td>
                  <div className="cell-text">
                    هذا نص معاينة لخلية المنشور كما ستظهر في جدول المنشورات بإعداداتك الحالية من
                    خط وتباعد وعرض وارتفاع.
                  </div>
                </td>
                <td>
                  <span className="badge status-new">جديد</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div className="row" style={{ marginBottom: 24 }}>
        <button type="button" className="btn" onClick={() => void save()} disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : '💾 حفظ الإعدادات'}
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setSettings(DEFAULT_APPEARANCE);
            void save(DEFAULT_APPEARANCE);
          }}
          disabled={busy}
        >
          ↺ استعادة الافتراضي
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() => setSettings(initial)}
          disabled={busy}
        >
          تراجع عن التغييرات غير المحفوظة
        </button>
      </div>
    </>
  );
}
