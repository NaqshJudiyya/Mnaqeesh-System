/**
 * Minimal XLSX (OOXML) writer.
 *
 * Reproduces the layout the extension itself produced — same column
 * order, right-to-left sheet view, bold frozen header, autofilter — so
 * files exported from مناقيش open exactly like the extension's exports.
 *
 * Column order (from the extension):
 *   # | اسم الحساب | التاريخ | الوقت | جمهور المنشور |
 *   نصوص المنشور | رابط الصورة/الصور | رابط الفيديو | رابط المنشور
 */

import { buildZip, type ZipEntry } from '@/lib/export/zip-writer';
import { PRIVACY_LABELS, type PostRow } from '@/lib/types';

export type XlsxRow = {
  author: string;
  date: string;
  time: string;
  privacy: string;
  text: string;
  imageUrls: string[];
  videoUrl: string;
  postUrl: string;
};

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index: number): string {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function cellXml(ref: string, value: unknown, styleIndex = 0): string {
  const textValue = String(value ?? '');
  const preserve = /^\s|\s$|\n/.test(textValue) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr" s="${styleIndex}"><is><t${preserve}>${escapeXml(textValue)}</t></is></c>`;
}

function privacyLabel(value: string): string {
  return PRIVACY_LABELS[value] ?? PRIVACY_LABELS.unknown;
}

function buildWorksheetXml(rows: XlsxRow[]): string {
  const widths = [6, 24, 14, 10, 16, 48, 58, 48, 58];
  const columns = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const header = [
    '#',
    'اسم الحساب',
    'التاريخ',
    'الوقت',
    'جمهور المنشور',
    'نصوص المنشور',
    'رابط الصورة / الصور',
    'رابط الفيديو',
    'رابط المنشور'
  ];

  const allRows: unknown[][] = [
    header,
    ...rows.map((row, index) => [
      index + 1,
      row.author,
      row.date,
      row.time,
      privacyLabel(row.privacy),
      row.text,
      (row.imageUrls || []).join('\n'),
      row.videoUrl,
      row.postUrl
    ])
  ];

  const xmlRows = allRows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const style = rowIndex === 0 ? 1 : 0;
      const cellsXml = cells
        .map((value, colIndex) => cellXml(`${excelColumnName(colIndex)}${r}`, value, style))
        .join('');
      return `<row r="${r}">${cellsXml}</row>`;
    })
    .join('');

  const lastRow = Math.max(1, allRows.length);

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${columns}</cols>` +
    `<sheetData>${xmlRows}</sheetData>` +
    `<autoFilter ref="A1:I${lastRow}"/>` +
    `</worksheet>`
  );
}

export async function buildXlsx(rows: XlsxRow[], sheetName = 'Facebook Posts'): Promise<Uint8Array> {
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Arial"/></font>` +
    `<font><b/><sz val="11"/><name val="Arial"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E5CB"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyAlignment="1"><alignment vertical="center" horizontal="center" wrapText="1"/></xf></cellXfs>` +
    // cellStyles is what Excel and openpyxl expect for the "Normal" style.
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const files: ZipEntry[] = [
    { path: '[Content_Types].xml', data: contentTypes },
    { path: '_rels/.rels', data: rootRels },
    { path: 'xl/workbook.xml', data: workbook },
    { path: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { path: 'xl/styles.xml', data: styles },
    { path: 'xl/worksheets/sheet1.xml', data: buildWorksheetXml(rows) }
  ];

  return buildZip(files);
}
/** Converts a post into the 9-column export shape (source language). */
export function postToXlsxRow(post: PostRow): XlsxRow {
  return {
    author: post.author,
    date: post.post_date,
    time: post.post_time,
    privacy: post.privacy,
    // The extension prefers edited markdown when present; keep that rule.
    text: post.markdown_text || post.text,
    imageUrls: post.image_urls || [],
    videoUrl: post.video_url,
    postUrl: post.post_url
  };
}
