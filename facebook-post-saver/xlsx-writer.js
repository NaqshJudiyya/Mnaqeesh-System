// Minimal XLSX/OOXML writer.
// Creates one worksheet with inline strings; ZIP compression is not required by Excel.

function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index) {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function cellXml(ref, value, styleIndex = 0) {
  const text = String(value ?? '');
  const preserve = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr" s="${styleIndex}"><is><t${preserve}>${escapeXml(text)}</t></is></c>`;
}

function buildWorksheetXml(rows) {
  const widths = [6, 24, 14, 10, 16, 48, 58, 48, 58];
  const columns = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const header = ['#', 'اسم الحساب', 'التاريخ', 'الوقت', 'جمهور المنشور', 'نصوص المنشور', 'رابط الصورة / الصور', 'رابط الفيديو', 'رابط المنشور'];
  const allRows = [header, ...rows.map((row, index) => [
    index + 1,
    row.author,
    row.date,
    row.time,
    privacyLabelForXlsx(row.privacy),
    row.text,
    (row.imageUrls || []).join('\n'),
    row.videoUrl,
    row.postUrl
  ])];

  const xmlRows = allRows.map((cells, rowIndex) => {
    const r = rowIndex + 1;
    const style = rowIndex === 0 ? 1 : 0;
    const cellsXml = cells.map((value, colIndex) => cellXml(`${excelColumnName(colIndex)}${r}`, value, style)).join('');
    return `<row r="${r}">${cellsXml}</row>`;
  }).join('');

  const lastRow = Math.max(1, allRows.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews>` +
    `<cols>${columns}</cols>` +
    `<sheetData>${xmlRows}</sheetData>` +
    `<autoFilter ref="A1:I${lastRow}"/>` +
    `</worksheet>`;
}

function privacyLabelForXlsx(value) {
  return value === 'public' ? 'عام' : value === 'friends' ? 'للأصدقاء' : 'غير معروف';
}

function buildXlsx(rows) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Facebook Posts" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Arial"/></font>` +
    `<font><b/><sz val="11"/><name val="Arial"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyAlignment="1"><alignment vertical="center" horizontal="center" wrapText="1"/></xf></cellXfs>` +
    `</styleSheet>`;

  const files = [
    { path: '[Content_Types].xml', data: new TextEncoder().encode(contentTypes) },
    { path: '_rels/.rels', data: new TextEncoder().encode(rootRels) },
    { path: 'xl/workbook.xml', data: new TextEncoder().encode(workbook) },
    { path: 'xl/_rels/workbook.xml.rels', data: new TextEncoder().encode(workbookRels) },
    { path: 'xl/styles.xml', data: new TextEncoder().encode(styles) },
    { path: 'xl/worksheets/sheet1.xml', data: new TextEncoder().encode(buildWorksheetXml(rows)) }
  ];

  return buildZip(files);
}
