/**
 * مظهر النظام — إعدادات التنسيق التي يتحكم فيها المدير.
 *
 * A single JSON document (site_settings row) drives a handful of CSS
 * custom properties injected on <html>, so the manager can retune the
 * site's colours, fonts, and table geometry without touching code.
 *
 * Every value is validated/clamped here — the only place — because the
 * settings ultimately reach the browser as CSS. A colour that is not
 * #rgb/#rrggbb or a font stack outside the whitelist is rejected, so a
 * manager cannot inject arbitrary CSS through the settings form.
 */

export type AppearanceSettings = {
  /** اللون الأساسي — أزرار، روابط، شرائح نشطة (كان --green). */
  primaryColor: string;
  /** اللون الغامق للعناوين والتحويم (كان --green-dark). */
  primaryDarkColor: string;
  /** لون التمييز الذهبي (كان --gold). */
  accentColor: string;
  /** لون خلفية الصفحة (كان --bg). */
  bgColor: string;
  /** لون النص الأساسي (كان --ink). */
  textColor: string;
  /** مفتاح مجموعة الخطوط من FONT_OPTIONS. */
  fontFamily: string;
  /** حجم خط الموقع الأساسي بالبكسل. */
  baseFontSize: number;
  /** حجم خط الجدول بالبكسل. */
  tableFontSize: number;
  /** تباعد أفقي داخل خلايا الجدول (العرض). */
  cellPaddingX: number;
  /** تباعد رأسي داخل خلايا الجدول (الارتفاع). */
  cellPaddingY: number;
  /** أقصى عرض لخلية نص المنشور. */
  textCellWidth: number;
  /** أقصى ارتفاع لخلية نص المنشور. */
  textCellHeight: number;
};

/** The values the stylesheet ships with — exactly the current design. */
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  primaryColor: '#256f4c',
  primaryDarkColor: '#1c5638',
  accentColor: '#b59059',
  bgColor: '#fafbf7',
  textColor: '#1f2a24',
  fontFamily: 'segui',
  baseFontSize: 15,
  tableFontSize: 13.5,
  cellPaddingX: 10,
  cellPaddingY: 8,
  textCellWidth: 460,
  textCellHeight: 108
};

/** System font stacks only — no webfonts are loaded, so the list is closed. */
export const FONT_OPTIONS: { key: string; label: string; stack: string }[] = [
  {
    key: 'segui',
    label: 'Segoe UI / Tahoma (الافتراضي)',
    stack: "'Segoe UI', Tahoma, 'Noto Naskh Arabic', Arial, sans-serif"
  },
  {
    key: 'naskh',
    label: 'نسخ عربي (Noto Naskh Arabic)',
    stack: "'Noto Naskh Arabic', 'Traditional Arabic', 'Times New Roman', serif"
  },
  { key: 'tahoma', label: 'Tahoma', stack: "Tahoma, 'Segoe UI', Arial, sans-serif" },
  { key: 'arial', label: 'Arial / Helvetica', stack: "Arial, Helvetica, 'Segoe UI', sans-serif" },
  { key: 'serif', label: 'تقليدي (Georgia)', stack: "Georgia, 'Times New Roman', serif" },
  {
    key: 'mono',
    label: 'أحادي المسافة (Consolas)',
    stack: "'Consolas', 'Courier New', monospace"
  }
];

export function fontStackOf(key: string): string {
  return (FONT_OPTIONS.find((option) => option.key === key) ?? FONT_OPTIONS[0]).stack;
}

/** Accepts #rgb or #rrggbb only — the safe subset of CSS colours. */
function normalizeColor(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(raw) ? raw : fallback;
}

/** Clamps a numeric setting into its inclusive range, with a step of 0.5. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n * 2) / 2;
  return Math.min(max, Math.max(min, snapped));
}

/**
 * Validates a FULL settings payload from the settings form.
 * Returns an error message in Arabic when anything is off — the PUT route
 * refuses partial/garbage payloads outright.
 */
export function normalizeAppearance(
  input: unknown
): { ok: true; value: AppearanceSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'بيانات الإعدادات غير صالحة.' };
  }
  const body = input as Record<string, unknown>;

  for (const [field, label] of [
    ['primaryColor', 'اللون الأساسي'],
    ['primaryDarkColor', 'اللون الأساسي الغامق'],
    ['accentColor', 'لون التمييز'],
    ['bgColor', 'لون الخلفية'],
    ['textColor', 'لون النص']
  ] as const) {
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(body[field] ?? ''))) {
      return { ok: false, error: `${label} يجب أن يكون لونًا بصيغة HEX مثل #256f4c.` };
    }
  }

  if (!FONT_OPTIONS.some((option) => option.key === body.fontFamily)) {
    return { ok: false, error: 'مجموعة الخطوط غير معروفة.' };
  }

  return {
    ok: true,
    value: {
      primaryColor: normalizeColor(body.primaryColor, DEFAULT_APPEARANCE.primaryColor),
      primaryDarkColor: normalizeColor(body.primaryDarkColor, DEFAULT_APPEARANCE.primaryDarkColor),
      accentColor: normalizeColor(body.accentColor, DEFAULT_APPEARANCE.accentColor),
      bgColor: normalizeColor(body.bgColor, DEFAULT_APPEARANCE.bgColor),
      textColor: normalizeColor(body.textColor, DEFAULT_APPEARANCE.textColor),
      fontFamily: String(body.fontFamily),
      baseFontSize: clampNumber(body.baseFontSize, 12, 20, DEFAULT_APPEARANCE.baseFontSize),
      tableFontSize: clampNumber(body.tableFontSize, 11, 18, DEFAULT_APPEARANCE.tableFontSize),
      cellPaddingX: clampNumber(body.cellPaddingX, 2, 28, DEFAULT_APPEARANCE.cellPaddingX),
      cellPaddingY: clampNumber(body.cellPaddingY, 2, 28, DEFAULT_APPEARANCE.cellPaddingY),
      textCellWidth: clampNumber(body.textCellWidth, 180, 900, DEFAULT_APPEARANCE.textCellWidth),
      textCellHeight: clampNumber(body.textCellHeight, 40, 400, DEFAULT_APPEARANCE.textCellHeight)
    }
  };
}

/**
 * Merges whatever is stored in the database over the defaults, sanitising
 * every field. Used on read paths, where a partial or old payload must
 * never break the page — unknown/garbage values silently fall back.
 */
export function mergeAppearance(stored: unknown): AppearanceSettings {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_APPEARANCE };
  const body = stored as Record<string, unknown>;
  return {
    primaryColor: normalizeColor(body.primaryColor, DEFAULT_APPEARANCE.primaryColor),
    primaryDarkColor: normalizeColor(body.primaryDarkColor, DEFAULT_APPEARANCE.primaryDarkColor),
    accentColor: normalizeColor(body.accentColor, DEFAULT_APPEARANCE.accentColor),
    bgColor: normalizeColor(body.bgColor, DEFAULT_APPEARANCE.bgColor),
    textColor: normalizeColor(body.textColor, DEFAULT_APPEARANCE.textColor),
    fontFamily: FONT_OPTIONS.some((option) => option.key === body.fontFamily)
      ? (body.fontFamily as string)
      : DEFAULT_APPEARANCE.fontFamily,
    baseFontSize: clampNumber(body.baseFontSize, 12, 20, DEFAULT_APPEARANCE.baseFontSize),
    tableFontSize: clampNumber(body.tableFontSize, 11, 18, DEFAULT_APPEARANCE.tableFontSize),
    cellPaddingX: clampNumber(body.cellPaddingX, 2, 28, DEFAULT_APPEARANCE.cellPaddingX),
    cellPaddingY: clampNumber(body.cellPaddingY, 2, 28, DEFAULT_APPEARANCE.cellPaddingY),
    textCellWidth: clampNumber(body.textCellWidth, 180, 900, DEFAULT_APPEARANCE.textCellWidth),
    textCellHeight: clampNumber(body.textCellHeight, 40, 400, DEFAULT_APPEARANCE.textCellHeight)
  };
}

/**
 * The CSS custom properties a settings payload produces.
 *
 * Returned as a plain record so it can be applied in two places with the
 * same keys: inline on <html> (server render) and via
 * `document.documentElement.style` (live preview in the settings form).
 */
export function appearanceCssVars(settings: AppearanceSettings): Record<string, string> {
  const lines = Math.max(
    1,
    Math.round(settings.textCellHeight / (settings.tableFontSize * 1.62))
  );
  return {
    '--green': settings.primaryColor,
    '--green-dark': settings.primaryDarkColor,
    '--gold': settings.accentColor,
    '--bg': settings.bgColor,
    '--ink': settings.textColor,
    '--font-body': fontStackOf(settings.fontFamily),
    '--base-font-size': `${settings.baseFontSize}px`,
    '--table-font-size': `${settings.tableFontSize}px`,
    '--cell-pad-x': `${settings.cellPaddingX}px`,
    '--cell-pad-y': `${settings.cellPaddingY}px`,
    '--text-cell-w': `${settings.textCellWidth}px`,
    '--text-cell-h': `${settings.textCellHeight}px`,
    '--text-cell-lines': String(lines)
  };
}
