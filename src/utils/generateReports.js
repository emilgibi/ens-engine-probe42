/**
 * generateReport.js  v4
 *
 * Fixes in this version:
 *   1. Legal table: Description column replaces Court (moved earlier, much wider)
 *   2. Half-width tables: all tables now use explicit DXA columnWidths so gridSpan is
 *      unambiguous — inner JSON tables fill 100% correctly
 *   3. Orphaned section headers: sectionBanner + kpiHeader merged into ONE table so
 *      Word's cantSplit forces them to stay together across page breaks
 *   4. Cover page: template XML fixed (w:type="auto" → w:type="dxa" on cover table)
 */

import * as fs from 'fs';
import {
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  ImageRun,
  Paragraph,
  patchDocument,
  PatchType,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import topdf from 'docx2pdf-converter';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { uploadReportToR2 } from './map_utils.js';
import { ContainerClient } from '@azure/storage-blob';
import { downloadImageBufferFromAzure } from './blob_utils.js';
import { formatHttpsURL, getOrdinalSuffix, getRiskColor, isValidURL } from './helpers.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateFinancialCharts } from './chart_utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const REPORTS_ROOT            = path.join(__dirname, 'local-reports');
const PDF_GENERATION_TIMEOUT_MS = 30000;

let template     = 'aramco_template.docx';
let links        = [];
let chartBuffers = {};
const kpi_codes  = ['NWS1A', 'ONF1A'];

// ─── Azure (SAS-token ContainerClient — matches production blob_utils.js) ─────
const {
  AZURE_STORAGE_ACCOUNT_NAME,
  REPORTS_CONTAINER_NAME,
  REPORTS_SAS_TOKEN,
  AZURE_OPENAI_ENDPOINT,      // e.g. https://your-resource-name.openai.azure.com
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT,    // deployment name, NOT the underlying model name
  AZURE_OPENAI_API_VERSION,
} = process.env;

const AZURE_API_VERSION = AZURE_OPENAI_API_VERSION || '2024-06-01'; // verified working against gpt-5 deployment

const _sasToken = REPORTS_SAS_TOKEN
  ? (REPORTS_SAS_TOKEN.startsWith('?') ? REPORTS_SAS_TOKEN : `?${REPORTS_SAS_TOKEN}`)
  : '';

const reportContainerUrl = AZURE_STORAGE_ACCOUNT_NAME && REPORTS_CONTAINER_NAME
  ? `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${REPORTS_CONTAINER_NAME}${_sasToken}`
  : null;

const reportContainerClient = reportContainerUrl ? new ContainerClient(reportContainerUrl) : null;

// Upload a single file buffer to blob path <blobName>
const _uploadBlob = async (filePath, blobName) => {
  if (!reportContainerClient) throw new Error('Azure container not configured (missing env vars)');
  const blobClient = reportContainerClient.getBlockBlobClient(blobName);
  await blobClient.uploadData(fs.readFileSync(filePath));
  return blobClient.url;
};

// Upload DOCX + PDF to <session_id>/<ens_id>/<fileName>.ext  (matches production)
const uploadReportToAzure = async (docxPath, pdfPath, session_id, ens_id, fileName) => {
  const docxBlobName = `${session_id}/${ens_id}/${fileName}.docx`;
  const pdfBlobName  = `${session_id}/${ens_id}/${fileName}.pdf`;
  const [docxUrl, pdfUrl] = await Promise.all([
    _uploadBlob(docxPath, docxBlobName),
    _uploadBlob(pdfPath,  pdfBlobName),
  ]);
  console.log('☁️  Azure DOCX:', docxUrl);
  console.log('☁️  Azure PDF: ', pdfUrl);
  return { docxBlobName, pdfBlobName, docxUrl, pdfUrl };
};

// Parse a Python-style list-of-dicts string OR valid JSON array (used for legal annexure)
function tryParseLegalList(contents) {
  if (!contents || typeof contents !== 'string') return null;
  const trimmed = contents.trim();
  if (!trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch {}
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('return ' + trimmed.replace(/\n/g, ' '))();
    if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') return result;
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DESIGN TOKENS — hex values matched exactly to template XML
// ═══════════════════════════════════════════════════════════════════════════════
const C = {
  yellow:    'FFE600',   // template FFE600 (exact match — was FFD100)
  grey:      '404040',   // section banner grey — darkened for contrast
  navy:      '1F3864',   // table column headers
  white:     'FFFFFF',
  offWhite:  'E0E0E0',   // alternating even rows — visible grey contrast
  silver:    'D9D9D9',   // borders
  // Severity
  sevHigh: 'FFCCCC', sevHighFg: 'C00000',
  sevMed:  'FFF3CC', sevMedFg:  'B8680A',
  sevLow:  'CCFFCC', sevLowFg:  '276221',
  // Status
  stPending: 'FFF3CC', stPendingFg: 'B8680A',
  stActive:  'FFCCCC', stActiveFg:  'C00000',
  stDispose: 'CCFFCC', stDisposeFg: '276221',
};

// ─── TABLE GEOMETRY (DXA, 1440 DXA = 1 inch) ─────────────────────────────────
// Content width ~9900 DXA  → 4 logical columns at 20 / 50 / 15 / 15 %
const TBL_W = 10050;
const COL   = [2010, 5025, 1508, 1507]; // 20/50/15/15% of 10050, must sum to TBL_W

const BDR  = { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' };
const NONE = { style: BorderStyle.NONE };
const allBorders  = { top: BDR, bottom: BDR, left: BDR, right: BDR };
const noBorders   = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideH: NONE, insideV: NONE };

// Safe colour lookup for any rating string (handles INFO, N/A, unknown)
const ratingStyle = (rating) => {
  try {
    const c = getRiskColor(String(rating ?? ''));
    return c ?? { color: '333333', background: 'FFFFFF' };
  } catch { return { color: '333333', background: 'FFFFFF' }; }
};

// ─── Utils ────────────────────────────────────────────────────────────────────
function safeText(v = '') {
  return String(v)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Cell factory ─────────────────────────────────────────────────────────────
// rowIdx >= 0 → alternating offWhite/white; bg = null → use rowIdx; span: gridSpan
const mkCell = (text, {
  bg       = null,
  rowIdx   = -1,
  color    = '000000',
  bold     = false,
  align    = AlignmentType.LEFT,
  span     = 1,       // gridSpan
  widthDxa = null,    // explicit DXA cell width
  fontSize = 18,
} = {}) => {
  const fill = bg ?? (rowIdx >= 0 ? (rowIdx % 2 === 0 ? C.offWhite : C.white) : C.white);
  return new TableCell({
    verticalAlign: 'center',
    columnSpan: span > 1 ? span : undefined,
    shading: { fill, type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 110, right: 110 },
    borders: allBorders,
    ...(widthDxa ? { width: { size: widthDxa, type: WidthType.DXA } } : {}),
    children: String(text ?? '').split(/\n+/).map(t =>
      new Paragraph({
        alignment: align,
        spacing: { before: 20, after: 20 },
        children: [new TextRun({ text: safeText(t), bold, size: fontSize, color })]
      })
    )
  });
};

// ─── Source line ──────────────────────────────────────────────────────────────
const sourceLine = (src = 'EY Network Alliance Databases') =>
  new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [
      new TextRun({ text: 'Source: ', bold: true, size: 18 }),
      new TextRun({ text: src, size: 18 })
    ]
  });

// ─── Rating patch ─────────────────────────────────────────────────────────────
const highlightRating = (rating) => ({
  type: PatchType.DOCUMENT,
  children: [new Table({
    width: { size: 15, type: WidthType.PERCENTAGE },
    borders: noBorders,
    rows: [new TableRow({ height: { rule: 'atLeast', value: 550 }, children: [
      new TableCell({
        verticalAlign: 'center',
        shading: { fill: getRiskColor(rating).background, type: ShadingType.CLEAR },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new TextRun({ text: `${rating}`, color: getRiskColor(rating).color, bold: true })
        ]})]
      })
    ]})]
  })]
});

const createTextRun = (options) => ({
  type: PatchType.PARAGRAPH,
  children: [new TextRun({ ...options, text: safeText(options.text) })]
});

// ─── No-hits placeholder ──────────────────────────────────────────────────────
const createNoHitsTable = (text = '') => [
  new Table({
    width: { size: TBL_W, type: WidthType.DXA },
    columnWidths: [TBL_W],
    borders: allBorders,
    rows: [new TableRow({ height: { rule: 'atLeast', value: 500 }, children: [
      new TableCell({
        verticalAlign: 'center',
        shading: { fill: C.offWhite, type: ShadingType.CLEAR },
        borders: allBorders,
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new TextRun({ text: text ? `${text} – NO TRUE HITS IDENTIFIED` : 'NO TRUE HITS IDENTIFIED', bold: true, size: 20 })
        ]})]
      })
    ]})]
  }),
  new Paragraph({})
];
const noAnnexure = () => createNoHitsTable('NO ANNEXURE');

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFIED KPI BLOCK  — sectionBanner + kpiHeader + Findings all in ONE table
//  with explicit columnWidths so gridSpan is unambiguous and inner tables
//  fill 100% of the full content width.
//
//  Layout:
//    Row 0 (optional): grey section banner   gridSpan=4
//    Row 1:            KPI header             4 columns
//    Row 2:            "Findings" grey label  gridSpan=4
//    Row 3:            content                gridSpan=4
// ═══════════════════════════════════════════════════════════════════════════════
function makeKpiBlock(kpi, contentChildren, sectionTitle = null) {
  // ── ONE outer row, ONE outer cell ─────────────────────────────────────────
  // cantSplit on the single outer row prevents Word from splitting the KPI
  // header from its content for short/medium tables.
  // For tables that span more than one page, the content cell itself will
  // still split — that is physically unavoidable in any word-processor.
  // ──────────────────────────────────────────────────────────────────────────

  // KPI header as a nested 4-column table (column widths are DXA and match
  // the outer cell width TBL_W, so proportions render correctly)
  const kpiHeaderTable = new Table({
    width: { size: TBL_W, type: WidthType.DXA },
    columnWidths: COL,
    borders: allBorders,
    rows: [new TableRow({ cantSplit: true, children: [
      mkCell('Name & Relation', { bg: C.navy, color: C.white, bold: true, widthDxa: COL[0] }),
      mkCell(kpi.kpi_definition, { bg: C.offWhite, align: AlignmentType.CENTER, widthDxa: COL[1] }),
      mkCell('Rating',           { bg: C.navy, color: C.white, bold: true, align: AlignmentType.CENTER, widthDxa: COL[2] }),
      mkCell(kpi.kpi_rating,     { bg: ratingStyle(kpi.kpi_rating).background, color: ratingStyle(kpi.kpi_rating).color, bold: true, align: AlignmentType.CENTER, widthDxa: COL[3] }),
    ]})]
  });

  return new Table({
    width: { size: TBL_W, type: WidthType.DXA },
    columnWidths: [TBL_W],
    borders: allBorders,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        shading: { fill: C.white, type: ShadingType.CLEAR },
        borders: allBorders,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [
          // Optional grey section banner as a shaded paragraph
          ...(sectionTitle ? [new Paragraph({
            shading: { fill: C.grey, type: ShadingType.CLEAR },
            indent: { left: 150, right: 80 },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: safeText(sectionTitle), bold: true, size: 22, color: C.white })]
          })] : []),
          // KPI header nested table
          kpiHeaderTable,
          // "Findings" label as a shaded paragraph
          new Paragraph({
            shading: { fill: C.grey, type: ShadingType.CLEAR },
            indent: { left: 110, right: 80 },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: 'Findings', bold: true, size: 19, color: C.white })]
          }),
          // Content
          ...contentChildren
        ]
      })]
    })]
  });
}

// ─── renderVal — module-level so it's available everywhere ──────────────────
function renderVal(v) {
  if (v === null || v === undefined) return [new Paragraph({ children: [new TextRun({ text: '—' })] })];
  if (typeof v === 'boolean') return [new Paragraph({ children: [new TextRun({ text: v ? 'Yes' : 'No' })] })];
  if (Array.isArray(v)) {
    if (!v.length) return [new Paragraph({ children: [new TextRun({ text: '—' })] })];
    // Arrays of URLs → one hyperlink per line (display shortened path, full URL as link)
    if (typeof v[0] === 'string' && /^https?:\/\//i.test(v[0])) {
      return v.map(url => {
        let display = url;
        try { const u = new URL(url); display = u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 40) + (u.pathname.length > 40 ? '…' : '') : ''); } catch {}
        return new Paragraph({ children: [new ExternalHyperlink({ link: url, children: [new TextRun({ text: display, style: 'Hyperlink', size: 16 })] })] });
      });
    }
    // Arrays of primitives → join with comma
    if (v.every(x => typeof x !== 'object')) {
      return [new Paragraph({ children: [new TextRun({ text: safeText(v.join(', ')), size: 18 })] })];
    }
    // Arrays of objects → stringify
    return [new Paragraph({ children: [new TextRun({ text: safeText(JSON.stringify(v)), size: 16 })] })];
  }
  if (typeof v === 'number') return [new Paragraph({ children: [new TextRun({ text: new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(v) })] })];
  const s = String(v).trim();
  if (/^https?:\/\/\S+$/i.test(s)) return [new Paragraph({ children: [new ExternalHyperlink({ link: s, children: [new TextRun({ text: s, style: 'Hyperlink' })] })] })];
  return [new Paragraph({ children: [new TextRun({ text: safeText(s), size: 18 })] })];
}

// ─── JSON inner table (navy headers, alternating rows, FULL width) ──────────
function makeJsonTable(data) {
  // Single plain object → transpose to Factor/Value rows for readability
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const SKIP = new Set(['score']);   // suppress noisy numeric noise fields
    const toLabel = k => k.replace(/_/g,' ').replace(/([A-Z])/g,' $1').trim().replace(/\b\w/g,m=>m.toUpperCase());
    const fvRows = Object.entries(data)
      .filter(([k]) => !SKIP.has(k))
      .map(([k, v]) => ({ factor: toLabel(k), value: v }));
    // Re-enter as 2-column table
    const fvW = [40, 60];
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: allBorders,
      rows: [
        new TableRow({ cantSplit: true, children: [
          new TableCell({ width:{size:fvW[0],type:WidthType.PERCENTAGE}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:'Parameter',bold:true,color:C.white,size:18})]})] }),
          new TableCell({ width:{size:fvW[1],type:WidthType.PERCENTAGE}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:'Value',bold:true,color:C.white,size:18})]})] }),
        ]}),
        ...fvRows.map((r, i) => new TableRow({ children: [
          new TableCell({ width:{size:fvW[0],type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:safeText(r.factor),bold:true,size:17})]})] }),
          new TableCell({ width:{size:fvW[1],type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children: renderVal(r.value) }),
        ]}))
      ]
    });
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (!rows.length) return null;

  const PREF = ['name','relation','relationship','type_of_transaction','period','rating_date',
    'rating_agency','rating','amount','type_of_loan','factor','2026','2025','2024','2023',
    'value','date_of_registration','state_of_registration','gst_in','filing_timeliness'];
  const keys  = new Set(); rows.forEach(r => Object.keys(r||{}).forEach(k => keys.add(k)));
  const all   = Array.from(keys);
  const cols  = [...PREF.filter(k => all.includes(k)), ...all.filter(k => !PREF.includes(k))];
  if (!cols.length) return null;

  const toTitle = (k) => String(k||'').replace(/_/g,' ').replace(/\b\w/g, m => m.toUpperCase());
  const cw = Math.max(5, Math.floor(100 / cols.length));  // percentage
  const lastCw = 100 - cw * (cols.length - 1);

  return new Table({
    width:   { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders,
    rows: [
      new TableRow({ cantSplit: true, children: cols.map((c, i) =>
        new TableCell({
          width: { size: i < cols.length-1 ? cw : lastCw, type: WidthType.PERCENTAGE },
          shading: { fill: C.navy, type: ShadingType.CLEAR },
          borders: allBorders, margins: { top: 60, bottom: 60, left: 110, right: 110 },
          children: [new Paragraph({ children: [new TextRun({ text: toTitle(c), bold: true, color: C.white, size: 18 })] })]
        })
      )}),
      ...rows.map((r, i) => new TableRow({ children: cols.map((c, ci) =>
        new TableCell({
          width: { size: ci < cols.length-1 ? cw : lastCw, type: WidthType.PERCENTAGE },
          shading: { fill: i%2===0 ? C.offWhite : C.white, type: ShadingType.CLEAR },
          borders: allBorders, margins: { top: 55, bottom: 55, left: 110, right: 110 },
          children: renderVal(r?.[c])
        })
      )}))
    ]
  });
}

// ─── Parse JSON safely ────────────────────────────────────────────────────────
function tryParseJson(s) {
  if (!s || !['[','{'].includes(String(s).trim()[0])) return null;
  try {
    return JSON.parse(
      String(s).replace(/&quot;|&#34;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    );
  } catch { return null; }
}

// ─── Hyperlink paragraph helper ───────────────────────────────────────────────
function urlPara(text) {
  const m   = text.match(/(https?:\/\/[^\s]+)/);
  let url   = m ? m[0] : null;
  let after = '';
  if (url) { after = text.replace(/.*https?:\/\/[^\s]+/, '').trim(); }
  if (url && url.includes('?')) url = null;
  return new Paragraph({ spacing: { after: 50, before: 50 }, children: [url
    ? new ExternalHyperlink({ link: url, children: [
        new TextRun({ text: '', break: 1 }), new TextRun({ text: 'Source:', bold: true }),
        new TextRun({ text: '', break: 1 }),
        new TextRun({ text: links.find(l=>l.url===url)?.title ?? 'Source Link', style: 'Hyperlink' }),
        new TextRun({ text: ` ${after}` }), new TextRun({ text: '', break: 1 })
      ]})
    : new TextRun({ text, bold: false })
  ]});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LEGAL HISTORY — colour-coded table, description replaces court column
//  Columns: Sr | Date | Case No. | Description (wide) | Category | Severity | Status
// ═══════════════════════════════════════════════════════════════════════════════
function parseLegalCases(text) {
  if (!text) return [];

  // Handle JSON/Python-list format: [{date, case_number, Description, severity, status, category}]
  const asList = tryParseLegalList(String(text));
  if (asList) {
    return asList.map((item, idx) => ({
      no:          String(idx + 1),
      date:        item.date ?? '—',
      severity:    (item.severity ?? '').toLowerCase(),
      status:      (item.status ?? '').toLowerCase(),
      caseNo:      item.case_number ?? '—',
      category:    item.category ?? '—',
      description: item.Description ?? item.description ?? '—',
    }));
  }

  // Handle legacy numbered-string format: "1. Date: XX | Severity: XX | Status: XX\nCase No. ..."
  return String(text).split(/\n(?=\d+\. Date:)/).reduce((acc, block) => {
    const m = block.match(/^(\d+)\.\s*Date:\s*([^|]+)\|\s*Severity:\s*([^|]+)\|\s*Status:\s*(.+)/m);
    if (!m) return acc;
    const [, no, date, severity, status] = m.map(s => s?.trim()??'');
    const rest    = block.replace(/^\d+\.[^\n]+\n?/,'').trim();
    const caseNoM = rest.match(/Case\s*No\.\s*([\S/]+(?:\s*\/\s*[\S]+)*)/i);
    const catM    = rest.match(/category of ([^.]+)/i);
    acc.push({
      no, date,
      severity: severity.trim().toLowerCase(),
      status:   status.trim().toLowerCase(),
      caseNo:   caseNoM ? caseNoM[1] : '—',
      category: catM    ? catM[1].trim() : '—',
      description: rest
    });
    return acc;
  }, []);
}

const sevStyle = (s) => s.includes('high') ? {bg:C.sevHigh,fg:C.sevHighFg} : s.includes('medium') ? {bg:C.sevMed,fg:C.sevMedFg} : s.includes('low') ? {bg:C.sevLow,fg:C.sevLowFg} : {bg:C.white,fg:'000000'};
const stStyle  = (s) => s.includes('pending') ? {bg:C.stPending,fg:C.stPendingFg} : /dispos|resolv|clos/.test(s) ? {bg:C.stDispose,fg:C.stDisposeFg} : s.includes('active') ? {bg:C.stActive,fg:C.stActiveFg} : {bg:C.white,fg:'000000'};
const cap = (s) => s ? s.charAt(0).toUpperCase()+s.slice(1) : '—';

function createLegalHistoryTable(findings) {
  const cases = parseLegalCases(findings.kpi_details);

  const contentChildren = cases.length
    ? [
        new Paragraph({}),
        (() => {
          // Columns: Sr(5) Date(8) Case No.(14) Description(44) Category(12) Severity(9) Status(8)
          // Proportional DXA from TBL_W=10050
          const LCOLS = [5, 7, 10, 48, 11, 10, 9]; // percentage widths, sum=100
          const LABELS = ['Sr.','Date','Case No.','Description','Category','Severity','Status'];
          const ALIGNS = [
            AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.LEFT,
            AlignmentType.LEFT, AlignmentType.LEFT,
            AlignmentType.CENTER, AlignmentType.CENTER
          ];
          return new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: allBorders,
            rows: [
              // Header
              new TableRow({ cantSplit: true, children: LABELS.map((l,i) =>
                new TableCell({
                  width: { size: LCOLS[i], type: WidthType.PERCENTAGE },
                  shading: { fill: C.navy, type: ShadingType.CLEAR },
                  borders: allBorders, margins: { top:60, bottom:60, left:80, right:80 },
                  children: [new Paragraph({ alignment: ALIGNS[i], children: [new TextRun({ text:l, bold:true, color:C.white, size:17 })] })]
                })
              )}),
              // Data rows
              ...cases.map((c, i) => {
                const sev = sevStyle(c.severity);
                const sta = stStyle(c.status);
                const bg  = i%2===0 ? C.offWhite : C.white;
                const cell = (txt, colIdx, override={}) => new TableCell({
                  width: { size: LCOLS[colIdx], type: WidthType.DXA },
                  shading: { fill: override.bg ?? bg, type: ShadingType.CLEAR },
                  borders: allBorders, margins: { top:55, bottom:55, left:80, right:80 },
                  children: [new Paragraph({ alignment: ALIGNS[colIdx], children: [
                    new TextRun({ text: safeText(String(txt)), bold: override.bold ?? false, color: override.fg ?? '000000', size: 17 })
                  ]})]
                });
                return new TableRow({ children: [
                  cell(c.no,           0),
                  cell(c.date,         1),
                  cell(c.caseNo,       2),
                  cell(c.description,  3),   // ← Description (wide)
                  cell(c.category,     4),
                  cell(cap(c.severity),5, { bg: sev.bg, fg: sev.fg, bold: true }),
                  cell(cap(c.status),  6, { bg: sta.bg, fg: sta.fg, bold: true }),
                ]});
              })
            ]
          });
        })(),
        new Paragraph({}),
        sourceLine(),
        new Paragraph({})
      ]
    : [new Paragraph({}), new Paragraph({ children: [new TextRun({ text: 'No legal cases identified.', italics: true })] }), new Paragraph({})];

  return [makeKpiBlock(findings, contentChildren), new Paragraph({})];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FINDINGS TABLE — text / URL paragraphs
// ═══════════════════════════════════════════════════════════════════════════════
function createFindingsTable(findings) {
  const bodyParas = (findings.kpi_details||'').trim().split(/\n+/).map(urlPara);
  const content = [
    new Paragraph({}),
    ...bodyParas,
    new Paragraph({}),
    !kpi_codes.includes(findings.kpi_code) && sourceLine(),
    new Paragraph({})
  ].filter(Boolean);

  return [makeKpiBlock(findings, content), new Paragraph({})];
}

// ─── EPFO row reorder (FSTB13A only) ──────────────────────────────────────────
// kpi_details for FSTB13A is a flat [{Parameter, Value}, ...] list built by the
// backend's epfo_analysis() from entry.items() in raw JSONB order. Row order is
// never touched by makeJsonTable (only column order is), so we reorder here:
// Establishment ID, Address, No. of Employees, Working EPFO Payment Amount,
// Payment Timeliness first (in that order), everything else after, unchanged.
const EPFO_PRIORITY = [
  /establishment.*id/i,
  /^address$/i,
  /no.*of.*employee|employee/i,
  /payment.*amount|amount.*payment/i,
  /timeliness/i,
];

function reorderEpfoRows(rows) {
  if (!Array.isArray(rows)) return rows;
  const rest = [...rows];
  const matched = [];
  for (const pattern of EPFO_PRIORITY) {
    const idx = rest.findIndex(r => pattern.test(String(r?.Parameter ?? '')));
    if (idx !== -1) matched.push(...rest.splice(idx, 1));
  }
  return [...matched, ...rest];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RELATION TABLE — JSON or text-based KPIs
// ═══════════════════════════════════════════════════════════════════════════════
function createRelationTable(findings) {
  let parsed = tryParseJson(findings?.kpi_details);
  if (findings?.kpi_code === 'FSTB13A' && Array.isArray(parsed)) {
    parsed = reorderEpfoRows(parsed);
  }
  const jt     = parsed ? makeJsonTable(parsed) : null;

  const content = jt
    ? [new Paragraph({}), jt, new Paragraph({}), !kpi_codes.includes(findings.kpi_code) && sourceLine(), new Paragraph({})].filter(Boolean)
    : [
        new Paragraph({}),
        ...(findings.kpi_details||'').trim().split(/\n+/).map(urlPara),
        new Paragraph({}),
        !kpi_codes.includes(findings.kpi_code) && sourceLine(),
        new Paragraph({})
      ].filter(Boolean);

  return [makeKpiBlock(findings, content), new Paragraph({})];
}

// ─── Inner indicator table (ESG / Cyber) ─────────────────────────────────────
function createFindingsInnerTable(findings) {
  const items   = findings.data || [];
  const iCols   = [4020, 2010, 4020]; // 40% + 20% + 40% = 10050
  const content = [
    new Paragraph({}),
    new Table({
      width: { size: TBL_W, type: WidthType.DXA }, columnWidths: iCols, borders: allBorders,
      rows: [
        new TableRow({ cantSplit: true, children: [
          new TableCell({ width:{size:iCols[0],type:WidthType.DXA}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110},
            children:[new Paragraph({children:[new TextRun({text:findings.inner_title,bold:true,color:C.white,size:18})]})] }),
          new TableCell({ width:{size:iCols[1],type:WidthType.DXA}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110},
            children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Rating',bold:true,color:C.white,size:18})]})] }),
          new TableCell({ width:{size:iCols[2],type:WidthType.DXA}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110},
            children:[new Paragraph({children:[new TextRun({text:'Notes',bold:true,color:C.white,size:18})]})] }),
        ]}),
        ...items.map((item,i) => new TableRow({ children: [
          new TableCell({ width:{size:iCols[0],type:WidthType.DXA}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:safeText(item.kpi_definition),size:18})]})] }),
          new TableCell({ width:{size:iCols[1],type:WidthType.DXA}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:safeText(item.kpi_rating),size:18})]})] }),
          new TableCell({ width:{size:iCols[2],type:WidthType.DXA}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:safeText(item.kpi_details),size:18})]})] }),
        ]}))
      ]
    }),
    new Paragraph({}),
    sourceLine(),
    findings.inner_title==='ESG Indicators' && new Paragraph({children:[new TextRun({text:'Notes: ',bold:true,underline:true}),new TextRun({text:'ESG Ratings: High/Weak 0–29; Medium/Moderate 30–49; Low/Robust 50–100'})]}),
    findings.inner_title==='Cyber Security Indicators' && new Paragraph({children:[new TextRun({text:'Notes: ',bold:true,underline:true}),new TextRun({text:'Cyber Ratings: High <651; Medium 651–750; Low 751–900'})]}),
    new Paragraph({})
  ].filter(Boolean);

  return [makeKpiBlock(findings, content), new Paragraph({})];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FINANCIAL SUMMARY — P&L + Balance Sheet tables (slide-24 style)
// ═══════════════════════════════════════════════════════════════════════════════
function createFinancialSummarySection(plKpi, bsKpi) {
  const parse = (k) => { try { return JSON.parse(k?.kpi_details ?? '[]'); } catch { return []; } };
  const plData = parse(plKpi), bsData = parse(bsKpi);
  const years  = (() => {
    const src = plData[0] ?? bsData[0];
    return src ? Object.keys(src).filter(k => k !== 'factor').sort() : [];
  })();

  const makeFinTable = (rows, title) => {
    if (!rows.length) return null;
    const nCols     = years.length + 1;
    const labelPct  = 38;
    const dataPct   = Math.floor((100 - labelPct) / years.length);
    const lastDataPct = 100 - labelPct - dataPct * (years.length - 1);

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: allBorders,
      rows: [
        // Yellow title row
        new TableRow({ cantSplit: true, children: [new TableCell({
          columnSpan: nCols, shading: { fill: C.yellow, type: ShadingType.CLEAR },
          borders: allBorders, margins: { top:80, bottom:80, left:140, right:80 },
          children: [new Paragraph({ keepNext: true, children: [new TextRun({ text: title, bold: true, size: 22, color: '2E2E38' })] })]
        })] }),
        // Navy column headers
        new TableRow({ cantSplit: true, children: [
          new TableCell({ width:{size:labelPct,type:WidthType.PERCENTAGE}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:'Particulars',bold:true,color:C.white,size:18})]})] }),
          ...years.map((y,i) => new TableCell({ width:{size:i<years.length-1?dataPct:lastDataPct,type:WidthType.PERCENTAGE}, shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:y,bold:true,color:C.white,size:18})]})] }))
        ]}),
        // Data rows
        ...rows.map((row, i) => {
          const isTot = (row.factor||'').toLowerCase().includes('total');
          return new TableRow({ children: [
            new TableCell({ width:{size:labelPct,type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:safeText(row.factor||'—'),bold:isTot,size:17})]})] }),
            ...years.map((y,ci) => new TableCell({ width:{size:ci<years.length-1?dataPct:lastDataPct,type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:row[y]!==undefined?new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(row[y]):'—',bold:isTot,size:17})]})] }))
          ]});
        })
      ]
    });
  };

  // Each summary KPI wrapped in makeKpiBlock so the rating (e.g. INFO) is visible
  const blocks = [];

  if (plKpi) {
    const plTable = makeFinTable(plData, 'Income Statement  (₹ in Lakhs)');
    if (plTable) {
      blocks.push(
        makeKpiBlock(plKpi, [new Paragraph({}), plTable, new Paragraph({}), sourceLine('EY Network Alliance Databases / Annual Reports'), new Paragraph({})]),
        new Paragraph({})
      );
    }
  }

  if (bsKpi) {
    const bsTable = makeFinTable(bsData, 'Balance Sheet  (₹ in Lakhs)');
    if (bsTable) {
      blocks.push(
        makeKpiBlock(bsKpi, [new Paragraph({}), bsTable, new Paragraph({}), sourceLine('EY Network Alliance Databases / Annual Reports'), new Paragraph({})]),
        new Paragraph({})
      );
    }
  }

  return blocks;
}

// ─── Chart data table (below every chart) ────────────────────────────────────
function makeChartDataTable(kpiRows) {
  if (!kpiRows?.length) return null;
  const first     = kpiRows[0];
  const factorKey = Object.keys(first).find(k => typeof first[k] === 'string') || 'factor';
  const years     = Object.keys(first).filter(k => k !== factorKey).sort();
  if (!years.length) return null;
  const labelPct  = 40;
  const dataPct   = Math.floor((100 - labelPct) / years.length);
  const lastDPct  = 100 - labelPct - dataPct * (years.length - 1);

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, borders: allBorders,
    rows: [
      new TableRow({ cantSplit: true, children: [
        new TableCell({ width:{size:labelPct,type:WidthType.PERCENTAGE}, shading:{fill:C.grey,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:'Particulars',bold:true,color:C.white,size:17})]})] }),
        ...years.map((y,i) => new TableCell({ width:{size:i<years.length-1?dataPct:lastDPct,type:WidthType.PERCENTAGE}, shading:{fill:C.grey,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:60,bottom:60,left:110,right:110}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:y,bold:true,color:C.white,size:17})]})] }))
      ]}),
      ...kpiRows.map((row,i) => new TableRow({ children: [
        new TableCell({ width:{size:labelPct,type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({children:[new TextRun({text:safeText(row[factorKey]??'—'),size:17})]})] }),
        ...years.map((y,ci) => new TableCell({ width:{size:ci<years.length-1?dataPct:lastDPct,type:WidthType.PERCENTAGE}, shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:110,right:110}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:row[y]!==undefined?(typeof row[y]==='number'?new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(row[y]):String(row[y])):'—',size:17})]})] }))
      ]}))
    ]
  });
}

// ─── Yellow sub-banner (chart section heading) ────────────────────────────────
const subBanner = (label) => new Table({
  width: { size: TBL_W, type: WidthType.DXA }, columnWidths: [TBL_W],
  borders: noBorders,
  rows: [new TableRow({ cantSplit: true, children: [new TableCell({
    shading: { fill: C.yellow, type: ShadingType.CLEAR }, borders: noBorders,
    margins: { top:75, bottom:75, left:150, right:80 },
    children: [new Paragraph({ keepNext: true, children: [new TextRun({ text: safeText(label), bold: true, size: 20, color: '2E2E38' })] })]
  })]})]
});

// ─── Grey section-only banner (for financial section headers) ─────────────────
const sectionOnlyBanner = (label) => new Table({
  width: { size: TBL_W, type: WidthType.DXA }, columnWidths: [TBL_W],
  borders: noBorders,
  rows: [new TableRow({ cantSplit: true, children: [new TableCell({
    shading: { fill: C.grey, type: ShadingType.CLEAR }, borders: noBorders,
    margins: { top:90, bottom:90, left:150, right:80 },
    children: [new Paragraph({ keepNext: true, children: [new TextRun({ text: safeText(label), bold: true, size: 22, color: C.white })] })]
  })]})]
});

// ─── Combined section-banner + KPI-header (ONE table, prevents orphaning) ────
function makeSectionKpiHeader(sectionTitle, kpi) {
  // ONE outer row so section title always travels with KPI header
  const kpiHeaderTable = new Table({
    width: { size: TBL_W, type: WidthType.DXA }, columnWidths: COL, borders: allBorders,
    rows: [new TableRow({ cantSplit: true, children: [
      mkCell('Name & Relation', { bg: C.navy, color: C.white, bold: true,  widthDxa: COL[0] }),
      mkCell(kpi.kpi_definition, { bg: C.offWhite, align: AlignmentType.CENTER, widthDxa: COL[1] }),
      mkCell('Rating',           { bg: C.navy, color: C.white, bold: true, align: AlignmentType.CENTER, widthDxa: COL[2] }),
      mkCell(kpi.kpi_rating,     { bg: ratingStyle(kpi.kpi_rating).background, color: ratingStyle(kpi.kpi_rating).color, bold: true, align: AlignmentType.CENTER, widthDxa: COL[3] }),
    ]})]
  });
  return new Table({
    width: { size: TBL_W, type: WidthType.DXA }, columnWidths: [TBL_W],
    borders: allBorders,
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({
      shading: { fill: C.white, type: ShadingType.CLEAR }, borders: allBorders,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      children: [
        new Paragraph({ shading: { fill: C.grey, type: ShadingType.CLEAR }, indent: { left: 150, right: 80 }, spacing: { before: 0, after: 0 },
          children: [new TextRun({ text: safeText(sectionTitle), bold: true, size: 22, color: C.white })] }),
        kpiHeaderTable
      ]
    })]})]  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FINANCIAL CHART SECTION — flat layout (no double-banner problem)
//  Structure: makeSectionKpiHeader → [subBanner → chart → dataTable] × N
// ═══════════════════════════════════════════════════════════════════════════════
function createFinancialChartSection(kpi, sectionTitle, chartsForKpi) {
  if (!chartsForKpi) return createRelationTable(kpi);

  const kpiRows = tryParseJson(kpi.kpi_details) || [];

  const CHART_CONFIGS = {
    FSTB1B: [
      { key:'combo', label:'Revenue, EBITDA and PAT Margin',                    w:500, h:305, filter: r => r.filter(x => /profit margin|pat margin|ebitda/i.test(x.factor||'')) },
      { key:'roa',   label:'Return on Assets (ROA) & Capital Employed (ROCE)',  w:500, h:280, filter: r => r.filter(x => /roe|roa|roce|return/i.test(x.factor||'')) },
    ],
    FSTB1C: [
      { key:'liquidity', label:'Liquidity Ratios',                               w:550, h:285, filter: r => r },
    ],
    FSTB1D: [
      { key:'oc',  label:'Operating Cycle (Debtor, Creditor & Inventory Days)',  w:500, h:270, filter: r => r.filter(x => /creditor|debtor|inventory/i.test(x.factor||'')) },
      { key:'atr', label:'Asset Turnover Ratio',                                 w:380, h:255, filter: r => r.filter(x => /asset turnover/i.test(x.factor||'')) },
    ],
    FSTB1E: [
      { key:'de',  label:'Debt – Equity Ratio',     w:380, h:255, filter: r => r.filter(x => /debt.*equity|d\/e/i.test(x.factor||'')) },
      { key:'icr', label:'Interest Coverage Ratio', w:380, h:255, filter: r => r.filter(x => /interest coverage/i.test(x.factor||'')) },
    ],
  };

  const configs = CHART_CONFIGS[kpi.kpi_code] || [];
  const sectionHeader = makeSectionKpiHeader(sectionTitle, kpi);
  const elements = [];

  // Wrap each chart (sub-banner + image + data table) in a single cantSplit table.
  // For the FIRST chart, include the sectionHeader inside the same cell so the
  // section title (e.g. "Profitability Analysis") always travels with its chart.
  configs.forEach(({ key, label, w, h, filter }, i) => {
    const buf  = chartsForKpi[key];
    const rows = filter ? filter(kpiRows) : kpiRows;
    const dt   = makeChartDataTable(rows);

    elements.push(
      new Table({
        width: { size: TBL_W, type: WidthType.DXA },
        columnWidths: [TBL_W],
        borders: noBorders,
        rows: [new TableRow({
          cantSplit: true,
          children: [new TableCell({
            shading: { fill: C.white, type: ShadingType.CLEAR },
            borders: noBorders,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            children: [
              // First chart carries the section KPI header inside the same block
              ...(i === 0 ? [sectionHeader, new Paragraph({})] : []),
              // Yellow sub-banner
              new Paragraph({
                shading: { fill: C.yellow, type: ShadingType.CLEAR },
                spacing: { before: 0, after: 0 },
                indent: { left: 150, right: 80 },
                children: [new TextRun({ text: safeText(label), bold: true, size: 20, color: '2E2E38' })]
              }),
              // Chart image
              new Paragraph({
                spacing: { before: 80, after: 80 },
                children: buf
                  ? [new ImageRun({ data: buf, type: 'png', transformation: { width: w, height: h } })]
                  : [new TextRun({ text: '[Chart unavailable]', italics: true, color: '999999' })]
              }),
              // Data table
              ...(dt ? [dt] : [])
            ]
          })]
        })]
      }),
      new Paragraph({})
    );
  });

  elements.push(sourceLine('EY Network Alliance Databases / Annual Reports'), new Paragraph({}));
  return elements;
}

// ─── Master financial section ─────────────────────────────────────────────────
function createFinancialFindingsSection(financialData) {
  const result = [];

  const plKpi = financialData.find(k => k.kpi_code==='FSTB3A');
  const bsKpi = financialData.find(k => k.kpi_code==='FSTB2A');
  if (plKpi || bsKpi) {
    result.push(...createFinancialSummarySection(plKpi, bsKpi));
  }

  const CHART_ORDER = [
    { code:'FSTB1B', title:'Profitability Analysis' },
    { code:'FSTB1C', title:'Liquidity Analysis'     },
    { code:'FSTB1D', title:'Operating Cycle'        },
    { code:'FSTB1E', title:'Capital Structure'      },
  ];
  for (const { code, title } of CHART_ORDER) {
    const kpi = financialData.find(k => k.kpi_code===code);
    if (kpi) result.push(...createFinancialChartSection(kpi, title, chartBuffers[code]));
  }

  const rendered = new Set(['FSTB3A','FSTB2A','FSTB1B','FSTB1C','FSTB1D','FSTB1E']);
  for (const kpi of financialData) {
    if (!rendered.has(kpi.kpi_code)) result.push(...createRelationTable(kpi));
  }
  return result;
}

// ─── Executive Summary (OpenAI) ────────────────────────────────────────────────
// Builds a compact 5-6 line narrative summary of the report's key findings.
// Scoped to fail SAFE: any error (missing key, network, bad response) logs a
// warning and returns a neutral fallback line so report generation never breaks.
function buildExecutiveSummaryPrompt(data, payload) {
  const lines = [];
  lines.push(`Company: ${data.name || 'N/A'}`);
  if (data.category) lines.push(`Category: ${data.category}`);
  if (data.location)  lines.push(`Location: ${data.location}`);
  lines.push(`Overall Risk Rating: ${data.risk_level || 'N/A'}`);

  if (Array.isArray(data.riskData)) {
    lines.push('Risk Areas:');
    data.riskData.forEach(r => lines.push(`- ${r.area}: ${r.rating}`));
  }

  // Lightweight counts of flagged findings per section (no raw finding text sent)
  const countFlags = (arr) => Array.isArray(arr) ? arr.filter(k => k?.kpi_flag).length : 0;
  const sectionCounts = [
    payload.legal_findings           && [`Legal findings flagged: ${countFlags(data.legal_data)}`],
    payload.financial_findings       && [`Financial findings flagged: ${countFlags(data.financial_data)}`],
    payload.cyber_esg_findings       && [`Cyber/ESG findings flagged: ${countFlags(data.cyber_esg_data)}`],
    payload.adverse_media_findings   && [`Adverse media findings flagged: ${countFlags(data.adverse_media_data)}`],
    payload.entity_existence_findings&& [`Entity existence findings flagged: ${countFlags(data.entity_existence_data)}`],
  ].filter(Boolean).flat();

  if (sectionCounts.length) lines.push(...sectionCounts);

  return [
    'You are a due-diligence analyst writing a formal Executive Summary for a vendor/supplier risk report.',
    'Using ONLY the structured data below, write a concise executive summary of exactly 5 to 6 sentences.',
    'Cover: overall risk posture, the most material risk area(s), and any notably clean areas.',
    'Do not invent facts not present in the data. Plain prose, no headers, no bullet points, no markdown.',
    '',
    lines.join('\n'),
  ].join('\n');
}

async function generateExecutiveSummary(data, payload) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) {
    console.warn('⚠️  AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT not fully set — skipping executive summary generation');
    return null;
  }
  try {
    const prompt = buildExecutiveSummaryPrompt(data, payload);
    const endpoint = AZURE_OPENAI_ENDPOINT.replace(/\/+$/, ''); // strip trailing slash if present
    const url = `${endpoint}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;

    let body = {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_completion_tokens: 800, // reasoning models (gpt-5, o1, o3...) spend tokens on hidden
                                  // reasoning before the visible answer, so this needs real headroom
      reasoning_effort: 'low',   // keep reasoning light — this is a short summary, not a hard problem
    };

    let response;
    try {
      response = await axios.post(url, body, {
        headers: { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
        timeout: 20000,
      });
    } catch (firstErr) {
      // Reasoning-family models (gpt-5, o1, o3...) reject some params outright
      // (e.g. non-default temperature, max_tokens vs max_completion_tokens).
      // Error codes vary ('unsupported_parameter', 'unsupported_value', etc.) —
      // match on the presence of a named `param` instead of a specific code,
      // and loop in case more than one param gets rejected in sequence.
      let err = firstErr;
      let attempts = 0;
      while (attempts < 3) {
        const badParam = err?.response?.data?.error?.param;
        if (!badParam || body[badParam] === undefined) throw err;
        console.warn(`⚠️  Model rejected '${badParam}' (${err?.response?.data?.error?.message || 'no detail'}) — retrying without it`);
        const { [badParam]: _drop, ...retryBody } = body;
        body = retryBody;
        attempts++;
        try {
          response = await axios.post(url, body, {
            headers: { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
            timeout: 20000,
          });
          break;
        } catch (retryErr) {
          err = retryErr;
          if (attempts === 3) throw err;
        }
      }
    }
    const summary = response.data?.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      const finishReason = response.data?.choices?.[0]?.finish_reason;
      if (finishReason === 'length') {
        throw new Error('Model ran out of tokens on reasoning before producing an answer — increase max_completion_tokens');
      }
      throw new Error('Empty summary content from Azure OpenAI response');
    }
    console.log('✅ Executive summary generated');
    return summary;
  } catch (err) {
    console.error('⚠️  Executive summary generation failed:', err?.response?.data?.error?.message || err.message);
    return null;
  }
}

// ─── Address validation images ────────────────────────────────────────────────
// ─── Async address-validation: downloads buffers directly from Azure via blob_utils ─
const createAddressValidationTable = async (entityId) => {
  if (!entityId) return [];

  const imageKeys = [
    `${entityId}_building.jpg`,
    `${entityId}_street.jpg`,
    `${entityId}_satellite.jpg`,
  ];

  const existingImages = [];
  for (const key of imageKeys) {
    try {
      const buffer = await downloadImageBufferFromAzure(key);
      console.log(`✅ Fetched address image: ${key}`);
      existingImages.push({ key, buffer });
    } catch {
      console.log(`ℹ️  Address image not found in Azure: ${key}`);
    }
  }

  if (!existingImages.length) return [];

  const cw = Math.floor(100 / existingImages.length);
  const ob = { style: BorderStyle.SINGLE, size: 6, color: 'D9D9D9' };

  // ONE row, ONE cell — title paragraph + images table in the same cell.
  // cantSplit on the row genuinely prevents any page break between title and images.
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [new TableRow({
        cantSplit: true,
        children: [new TableCell({
          shading: { fill: C.white, type: ShadingType.CLEAR },
          borders: noBorders,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          children: [
            // Title
            new Paragraph({
              spacing: { before: 160, after: 80 },
              children: [new TextRun({ text: 'Address Validation', bold: true, size: 24 })]
            }),
            // Images (nested table)
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: { top:ob, bottom:ob, left:ob, right:ob, insideH:NONE, insideV:NONE },
              rows: [new TableRow({
                children: existingImages.map(({ buffer }, idx) => new TableCell({
                  width: { size: cw, type: WidthType.PERCENTAGE },
                  shading: { fill: C.white, type: ShadingType.CLEAR },
                  margins: { top:150, bottom:150, left:150, right:150 },
                  borders: { top:ob, bottom:ob, left:idx===0?ob:NONE, right:idx===existingImages.length-1?ob:NONE },
                  children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new ImageRun({ data: buffer, type:'jpg', transformation:{ width:180, height:120 } })]
                  })]
                }))
              })]
            })
          ]
        })]
      })]
    }),
    new Paragraph({})
  ];
};

// ═══════════════════════════════════════════════════════════════════════════════
//  DIRECTOR NETWORK ANNEXURE — Sr | Director Name | DIN | Network (multi-line bullets)
//  contents: [{ "Director Name": "...", "DIN": "...", "Network": "• Co — Role (from – to)\n• ..." }, ...]
// ═══════════════════════════════════════════════════════════════════════════════
function directorNetworkTable(info, directors) {
  const titleRow = new TableRow({ cantSplit: true, children: [new TableCell({
      shading:{fill:C.offWhite,type:ShadingType.CLEAR}, borders:allBorders,
      margins:{top:70,bottom:70,left:110,right:110}, columnSpan: 1,
      children:[new Paragraph({keepNext:true,children:[new TextRun({text:safeText(info.title),bold:true,size:20})]})]
    })] });

  const DCOLS  = [6, 24, 12, 58]; // percentage widths, sum = 100
  const LABELS = ['Sr.', 'Director Name', 'DIN', 'Network'];
  const ALIGNS = [AlignmentType.CENTER, AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.LEFT];

  const headerRow = new TableRow({ cantSplit: true, children: LABELS.map((l, i) =>
        new TableCell({
          width: { size: DCOLS[i], type: WidthType.PERCENTAGE },
          shading: { fill: C.navy, type: ShadingType.CLEAR }, borders: allBorders,
          margins: { top:60, bottom:60, left:80, right:80 },
          children: [new Paragraph({ alignment: ALIGNS[i], children: [new TextRun({ text: l, bold: true, color: C.white, size: 17 })] })]
        })
    )});

  const dataRows = directors.map((d, i) => {
    const bg      = i % 2 === 0 ? C.offWhite : C.white;
    const name    = d['Director Name'] ?? d.director_name ?? d.name ?? '—';
    const din     = d['DIN'] ?? d.din ?? '—';
    const network = d['Network'] ?? d.network ?? '';
    const networkLines = String(network).split(/\n+/).map(l => l.trim()).filter(Boolean);

    return new TableRow({ children: [
        new TableCell({ width:{size:DCOLS[0],type:WidthType.PERCENTAGE}, shading:{fill:bg,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:80,right:80},
          children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:String(i+1),size:17})]})] }),
        new TableCell({ width:{size:DCOLS[1],type:WidthType.PERCENTAGE}, shading:{fill:bg,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:80,right:80},
          children:[new Paragraph({children:[new TextRun({text:safeText(name),bold:true,size:17})]})] }),
        new TableCell({ width:{size:DCOLS[2],type:WidthType.PERCENTAGE}, shading:{fill:bg,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:80,right:80},
          children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:safeText(din),size:17})]})] }),
        new TableCell({ width:{size:DCOLS[3],type:WidthType.PERCENTAGE}, shading:{fill:bg,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:55,bottom:55,left:80,right:80},
          children: networkLines.length
              ? networkLines.map(line => new Paragraph({ spacing:{before:15,after:15}, children:[new TextRun({text:safeText(line),size:16})] }))
              : [new Paragraph({children:[new TextRun({text:'—',size:16})]})]
        }),
      ]});
  });

  return [
    new Table({ width:{size:TBL_W,type:WidthType.DXA}, columnWidths:[TBL_W], borders:allBorders, rows:[titleRow] }),
    new Paragraph({}),
    new Table({ width:{size:100,type:WidthType.PERCENTAGE}, borders:allBorders, rows:[headerRow, ...dataRows] }),
    new Paragraph({}),
    sourceLine(),
    new Paragraph({})
  ];
}

// ─── Annexure ─────────────────────────────────────────────────────────────────
function annexureTable(info) {
  // Title row (shared for all variants)
  const titleRow = new TableRow({ cantSplit: true, children: [new TableCell({
    shading:{fill:C.offWhite,type:ShadingType.CLEAR}, borders:allBorders,
    margins:{top:70,bottom:70,left:110,right:110}, columnSpan: 1,
    children:[new Paragraph({keepNext:true,children:[new TextRun({text:safeText(info.title),bold:true,size:20})]})]
  })] });

  const rawContents = info.contents;

  // Detect director network: title contains "Director Network" AND contents is a
  // parseable list of { "Director Name", "DIN", "Network" } objects (or Python-list string)
  const directorNetworkRows = /director\s*network/i.test(info.title)
    ? (Array.isArray(rawContents) ? rawContents : tryParseLegalList(String(rawContents ?? '')))
    : null;

  if (directorNetworkRows && directorNetworkRows.length > 0) {
    return directorNetworkTable(info, directorNetworkRows);
  }

  // Detect legal history: title contains "Legal" AND contents is a parseable list
  // contents may arrive as a plain string, a Python-list string, or a real JS array
  const legalCases = /legal/i.test(info.title)
    ? (Array.isArray(rawContents)
        ? rawContents.map((item, idx) => ({
            no:          String(idx + 1),
            date:        item.date ?? '—',
            severity:    (item.severity ?? '').toLowerCase(),
            status:      (item.status ?? '').toLowerCase(),
            caseNo:      item.case_number ?? '—',
            category:    item.category ?? '—',
            description: item.Description ?? item.description ?? '—',
          }))
        : tryParseLegalList(String(rawContents ?? '')))
    : null;

  if (legalCases && legalCases.length > 0) {
    // Render as full coloured legal table (same column layout as main legal section)
    const LCOLS = [5, 7, 10, 48, 11, 10, 9]; // percentage widths sum = 100
    const LABELS = ['Sr.','Date','Case No.','Description','Category','Severity','Status'];
    const ALIGNS = [
      AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.LEFT,
      AlignmentType.LEFT, AlignmentType.LEFT,
      AlignmentType.CENTER, AlignmentType.CENTER
    ];

    const headerRow = new TableRow({ cantSplit: true, children: LABELS.map((l,i) =>
      new TableCell({
        width:{size:LCOLS[i],type:WidthType.DXA},
        shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders,
        margins:{top:60,bottom:60,left:80,right:80},
        children:[new Paragraph({alignment:ALIGNS[i],children:[new TextRun({text:l,bold:true,color:C.white,size:17})]})]
      })
    )});

    const dataRows = legalCases.map((c, i) => {
      const sev = sevStyle(c.severity);
      const sta = stStyle(c.status);
      const bg  = i%2===0 ? C.offWhite : C.white;
      return new TableRow({ children: [
        new TableCell({width:{size:LCOLS[0],type:WidthType.PERCENTAGE},shading:{fill:bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:safeText(String(c.no)),size:17})]})]}),
        new TableCell({width:{size:LCOLS[1],type:WidthType.PERCENTAGE},shading:{fill:bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:safeText(c.date),size:17})]})]}),
        new TableCell({width:{size:LCOLS[2],type:WidthType.PERCENTAGE},shading:{fill:bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:safeText(c.caseNo),size:17})]})]}),
        new TableCell({width:{size:LCOLS[3],type:WidthType.PERCENTAGE},shading:{fill:bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:safeText(c.description),size:15})]})]}),
        new TableCell({width:{size:LCOLS[4],type:WidthType.PERCENTAGE},shading:{fill:bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:safeText(c.category),size:17})]})]}),
        new TableCell({width:{size:LCOLS[5],type:WidthType.PERCENTAGE},shading:{fill:sev.bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:cap(c.severity),bold:true,color:sev.fg,size:17})]})]}),
        new TableCell({width:{size:LCOLS[6],type:WidthType.PERCENTAGE},shading:{fill:sta.bg,type:ShadingType.CLEAR},borders:allBorders,margins:{top:55,bottom:55,left:80,right:80},children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:cap(c.status),bold:true,color:sta.fg,size:17})]})]})
      ]});
    });

    return [
      // Title banner
      new Table({
        width:{size:TBL_W,type:WidthType.DXA}, columnWidths:[TBL_W], borders:allBorders,
        rows:[titleRow]
      }),
      new Paragraph({}),
      // Legal cases table
      new Table({
        width:{size:100,type:WidthType.PERCENTAGE}, borders:allBorders,
        rows:[headerRow, ...dataRows]
      }),
      new Paragraph({}),
      sourceLine(),
      new Paragraph({})
    ];
  }

  // Default: plain-text annexure
  return [
    new Table({
      width: { size: TBL_W, type: WidthType.DXA }, columnWidths: [TBL_W], borders: allBorders,
      rows: [
        titleRow,
        new TableRow({ children: [new TableCell({
          shading:{fill:C.white,type:ShadingType.CLEAR}, borders:allBorders,
          margins:{top:60,bottom:60,left:110,right:110},
          children:[
            ...String(rawContents ?? '').trim().split(/\n+/).map(t=>new Paragraph({children:[new TextRun({text:safeText(t),size:18,break:1})]})),
            new Paragraph({})
          ]
        })]  })
      ]
    }),
    new Paragraph({})
  ];
}

// ─── URL helpers ──────────────────────────────────────────────────────────────
const processKpiDetails = (f) => (f.kpi_details?.trim().split(/\n+/)??[])
  .map(t=>t.match(/(https?:\/\/[^\s]+)/)?.[0]??null).filter(Boolean);

const getPageTitle = async (url) => {
  try {
    const $=cheerio.load((await axios.get(url)).data);
    return $('meta[property="og:title"]').attr('content')?.trim() || $('title').text().trim() || 'Source Link';
  } catch { return 'Source Link'; }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
export const generateReport = async (payload) => {
  try {
    links = []; chartBuffers = {};
    const disableReg = !!payload['disable-regulator-and-legal'];

    const data = {
      ...payload,
      riskData: [
        { area:'Entity Existence', rating: payload.entity_existence_rating ?? 'Low' },
        { area:'Legal',            rating: payload.legal_rating             ?? 'Low' },
        { area:'Financial',        rating: payload.financial_rating         ?? 'Low' },
        { area:'Adverse Media',    rating: payload.adverse_media_rating     ?? 'Low' },
        { area:'Cyber',            rating: payload.cyber_esg_rating         ?? 'Low' },
      ],
    };

    // Pre-fetch URL titles
    let urls = [];
    ['leg_data','adv_data','ent_data','fin_data'].forEach(p=>{if(data[p])data[p].forEach(i=>{urls=[...urls,...processKpiDetails(i)];});});
    links = await Promise.all(urls.map(async u=>({url:u,title:await getPageTitle(u)})));

    // Pre-generate charts
    if (payload.financial_findings && data.financial_data?.length) {
      console.log('⏳ Generating financial charts…');
      chartBuffers = await generateFinancialCharts(data.financial_data);
      console.log('✅ Charts:', Object.keys(chartBuffers).join(', '));
    }

    // Executive summary (OpenAI) — generated once, reused in the patch below
    console.log('⏳ Generating executive summary…');
    const executiveSummaryText = await generateExecutiveSummary(data, payload);

    if (disableReg) template = 'aramco_template-no-regulatory-legal.docx';
    const TEMPLATE_PATH = path.join(__dirname, '..', 'template', template);
    const date = new Date(); const day = date.getDate();

    const doc = await patchDocument({
      outputType: 'nodebuffer',
      data: fs.readFileSync(TEMPLATE_PATH),
      patches: {
        // Cover
        vendorId:     createTextRun({ text:`Supplier ID: ${data.external_vendor_id}` }),
        uploadedName: createTextRun({ text:`[${data.uploaded_name}]` }),
        title:        createTextRun({ text: data.name }),
        created_date: { type:PatchType.PARAGRAPH, children:[
          new TextRun({text:`${day}`}),
          new TextRun({text:getOrdinalSuffix(day),superScript:true}),
          new TextRun({text:` ${date.toLocaleString('en-US',{month:'long'})} ${date.getFullYear()}`}),
        ]},
        // Profile
        company_name:               createTextRun({text:data.name}),
        company_location:           createTextRun({text:data.location}),
        company_category:           createTextRun({text:data.category}),
        company_address:            createTextRun({text:data.address}),
        company_uploaded_name:      createTextRun({text:data.uploaded_name}),
        company_external_vendor_id: createTextRun({text:data.external_vendor_id}),
        company_website: { type:PatchType.DOCUMENT, children:[new Paragraph({children:[
          isValidURL(data.website)
            ? new ExternalHyperlink({children:[new TextRun({text:data.website,style:'Hyperlink'})],link:formatHttpsURL(data.website)})
            : new TextRun({text:data.website})
        ]})]},
        company_e_filing_status:    createTextRun({text:data.e_filing_status}),
        company_category_type:      createTextRun({text:data.category}),
        company_national_identifier:createTextRun({text:data.identifier}),
        company_corporate_group:    createTextRun({text:data.company_corporate_group}),
        company_alias: { type:PatchType.DOCUMENT, children:[new Paragraph({}), ...data.alias.split(/\n+/).map(t=>new Paragraph({children:[new TextRun({text:t,break:1})]})), new Paragraph({})] },
        company_incorporation_date: createTextRun({text:data.incorporation_date}),
        company_subsidiaries:       createTextRun({text:data.subsidiaries}),
        shareholders:               { type:PatchType.DOCUMENT, children:[new Paragraph({}), ...data.shareholders.split('\n').map(s=>new Paragraph(s)), new Paragraph({})] },
        key_executives:             { type:PatchType.DOCUMENT, children:[new Paragraph({}), ...data.key_executives.split('\n').map(e=>new Paragraph(e)), new Paragraph({})] },
        company_revenue:  createTextRun({text:data.revenue}),
        company_employee: createTextRun({text:data.employee_count}),

        // Executive Summary (grey banner + AI-generated narrative, shown after
        // Company Profile and before Overall Risk Rating)
        executive_summary: { type:PatchType.DOCUMENT, children:[
          sectionOnlyBanner('Executive Summary'),
          new Paragraph({}),
          new Paragraph({ children:[new TextRun({
            text: executiveSummaryText || 'Executive summary unavailable for this report.',
            size: 20,
          })] }),
          new Paragraph({}),
        ]},

        // Overall rating (navy header + coloured value)
        overall_rating: { type:PatchType.DOCUMENT, children:[new Table({
          columnWidths:[7000,3000], width:{size:10000,type:WidthType.DXA}, alignment:'center',
          rows:[new TableRow({ height:{rule:'atLeast',value:560}, children:[
            new TableCell({ verticalAlign:'center', shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, width:{size:7000,type:WidthType.DXA}, margins:{top:90,bottom:90,left:160,right:160},
              children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'OVERALL RISK RATING',bold:true,size:26,color:C.white})]})] }),
            new TableCell({ verticalAlign:'center', shading:{fill:getRiskColor(data.risk_level).background,type:ShadingType.CLEAR}, borders:allBorders, width:{size:3000,type:WidthType.DXA}, margins:{top:90,bottom:90,left:160,right:160},
              children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:data.risk_level,bold:true,size:28,color:getRiskColor(data.risk_level).color,allCaps:true})]})] }),
          ]})]
        })]},

        // Risk areas (navy header, alternating rows, coloured ratings)
        risk_areas: { type:PatchType.DOCUMENT, children:[new Table({
          columnWidths:[7400,2600], width:{size:10000,type:WidthType.DXA}, borders:allBorders,
          rows:[
            new TableRow({ height:{rule:'atLeast',value:560}, children:[
              new TableCell({ width:{size:7400,type:WidthType.DXA}, verticalAlign:'center', shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:90,bottom:90,left:160,right:120}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Risk Areas',bold:true,color:C.white,size:20})]})] }),
              new TableCell({ verticalAlign:'center', shading:{fill:C.navy,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:90,bottom:90,left:120,right:120}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Risk Rating',bold:true,color:C.white,size:20})]})] }),
            ]}),
            ...data.riskData.map((risk,i)=>new TableRow({ height:{rule:'atLeast',value:480}, children:[
              new TableCell({ width:{size:7400,type:WidthType.DXA}, verticalAlign:'center', shading:{fill:i%2===0?C.offWhite:C.white,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:70,bottom:70,left:160,right:120}, children:[new Paragraph({children:[new TextRun({text:risk.area,size:19})]})] }),
              new TableCell({ verticalAlign:'center', shading:{fill:getRiskColor(risk.rating).background,type:ShadingType.CLEAR}, borders:allBorders, margins:{top:70,bottom:70,left:120,right:120}, children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:risk.rating,color:getRiskColor(risk.rating).color,size:20,bold:true})]})] }),
            ]}))
          ]
        })]},

        a_rating: highlightRating(data.riskData[0].rating),
        b_rating: highlightRating(data.riskData[1].rating),
        c_rating: highlightRating(data.riskData[2].rating),
        d_rating: highlightRating(data.riskData[3].rating),
        e_rating: highlightRating(data.riskData[4].rating),

        ...(!disableReg && {
          g_rating: highlightRating(data.riskData[6]?.rating ?? 'Low'),
          regularity_findings: { type:PatchType.DOCUMENT,
            children: data.reg_findings ? data.reg_data.map(createFindingsTable).flat() : createNoHitsTable('REGULATORY') },
        }),

        page_break: { type:PatchType.DOCUMENT, children:[new Paragraph({pageBreakBefore:true})] },

        legal_findings: { type:PatchType.DOCUMENT,
          children: payload.legal_findings
            ? data.legal_data.map(f => (f.kpi_code==='LEG1A'||/legal history/i.test(f.kpi_definition||''))
                ? createLegalHistoryTable(f) : createRelationTable(f)).flat()
            : createNoHitsTable('LEGAL')
        },

        financial_findings: { type:PatchType.DOCUMENT,
          children: payload.financial_findings && data.financial_data?.length
            ? createFinancialFindingsSection(data.financial_data)
            : createNoHitsTable('FINANCIALS')
        },

        cyber_esg_findings: { type:PatchType.DOCUMENT,
          children: payload.cyber_esg_findings
            ? data.cyber_esg_data.map(createRelationTable).flat()
            : createNoHitsTable('CYBER')
        },

        adverse_media_findings: { type:PatchType.DOCUMENT,
          children: payload.adverse_media_findings
            ? data.adverse_media_data.map(createFindingsTable).flat()
            : createNoHitsTable('ADVERSE MEDIA')
        },

        entity_existence_findings: { type:PatchType.DOCUMENT,
          children: [
            ...(payload.entity_existence_findings ? data.entity_existence_data.map(createRelationTable).flat() : createNoHitsTable('ENTITY EXISTENCE')),
            ...(await createAddressValidationTable(data.google_image_name))
          ]
        },

        annexure: { type:PatchType.DOCUMENT,
          children: data.annexure?.length>0 ? data.annexure.map(annexureTable).flat() : noAnnexure()
        },
      },
    });

    // File I/O
    const fileName   = `${payload.ens_id}`;
    const docxPath   = path.join(__dirname, `${fileName}.docx`);
    const pdfPath    = path.join(__dirname, `${fileName}.pdf`);
    const ensDir     = path.join(REPORTS_ROOT, payload.session_id, payload.ens_id);
    fs.mkdirSync(ensDir, { recursive: true });

    fs.writeFileSync(docxPath, Buffer.isBuffer(doc) ? doc : Buffer.from(doc));
    await Promise.resolve(topdf.convert(docxPath, pdfPath));

    const deadline = Date.now() + PDF_GENERATION_TIMEOUT_MS;
    while (!fs.existsSync(pdfPath)) {
      if (Date.now() > deadline) throw new Error('PDF generation timed out');
      await new Promise(r => setTimeout(r, 200));
    }

    const localDocxPath = path.join(ensDir, `${fileName}.docx`);
    const localPdfPath  = path.join(ensDir, `${fileName}.pdf`);
    fs.copyFileSync(docxPath, localDocxPath);
    fs.copyFileSync(pdfPath,  localPdfPath);
    console.log('✅ DOCX:', localDocxPath);
    console.log('✅ PDF:',  localPdfPath);

    // Upload to Azure Blob (session_id/ens_id/fileName.ext)
    await uploadReportToAzure(docxPath, pdfPath, payload.session_id, data.ens_id, fileName);

    // Optionally also upload to R2 if configured
    if (typeof uploadReportToR2 === 'function') {
      try { await uploadReportToR2(docxPath, pdfPath, payload.session_id, data.ens_id, fileName); }
      catch (r2err) { console.warn('R2 upload skipped:', r2err.message); }
    }

    await Promise.all([fs.promises.unlink(docxPath), fs.promises.unlink(pdfPath)]);

  } catch (err) {
    console.error('Report generation failed:', err);
    throw new Error('Report generation failed');
  }
};