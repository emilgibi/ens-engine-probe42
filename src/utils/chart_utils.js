/**
 * chart_utils.js
 *
 * Generates PNG chart buffers for financial KPIs using Vega (server-side, no browser needed)
 * and converts them to PNG via sharp.
 *
 * Requires:
 *   npm install vega sharp
 */

import * as vega from 'vega';
import sharp from 'sharp';

// ─── EY Color Palette (matched exactly to template FFE600 yellow) ─────────────
export const EY = {
  navy:      '#1F3864',
  yellow:    '#FFE600',   // exact match to aramco template FFE600
  grey:      '#595959',
  darkGrey:  '#404040',
  lightGrey: '#BFBFBF',
  silver:    '#D9D9D9',
  white:     '#FFFFFF',
  green:     '#70AD47',
  red:       '#C00000',
  orange:    '#ED7D31',
};

// ─── Vega → PNG helper ───────────────────────────────────────────────────────
async function svgToPng(svgString) {
  return sharp(Buffer.from(svgString)).png().toBuffer();
}

async function renderVegaSpec(spec) {
  const view = new vega.View(vega.parse(spec), { renderer: 'none' });
  await view.runAsync();
  const svg = await view.toSVG();
  return svgToPng(svg);
}

// ─── Utility: extract year/period columns from row array ─────────────────────
function getYearCols(rows) {
  if (!rows || !rows.length) return [];
  const exclude = new Set(['factor', 'name', 'parameter', 'calculation', 'period', 'value']);
  return Object.keys(rows[0]).filter(k => !exclude.has(k)).sort();
}

function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Adaptive domain: includes negative values with 20% padding below, 25% above
function adaptiveDomain(values, forcedMin = null) {
  const finite = values.filter(v => isFinite(v) && !isNaN(v));
  if (!finite.length) return [0, 10];
  const mn = Math.min(...finite);
  const mx = Math.max(...finite);
  const pad = Math.max(Math.abs(mx - mn) * 0.15, Math.abs(mx) * 0.15, 1);
  const lo = forcedMin !== null ? forcedMin : (mn < 0 ? mn - pad : 0);
  const hi = mx + pad;
  return [lo, hi === lo ? lo + 1 : hi];
}

function findRow(rows, substrings) {
  for (const sub of (Array.isArray(substrings) ? substrings : [substrings])) {
    const r = rows.find(r => r.factor && r.factor.toLowerCase().includes(sub.toLowerCase()));
    if (r) return r;
  }
  return null;
}

function fmtNum(n) {
  if (Math.abs(n) >= 100000) return (n / 1000).toFixed(0) + 'K';
  if (Math.abs(n) >= 1000)   return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// ─── LEGEND SPEC ─────────────────────────────────────────────────────────────
function legendMark(x, y, color, label, dash = false) {
  return [
    {
      type: 'rule',
      encode: { enter: {
        x: { value: x }, x2: { value: x + 22 },
        y: { value: y + 6 }, stroke: { value: color }, strokeWidth: { value: 2 },
        strokeDash: dash ? { value: [4, 2] } : { value: [] }
      }}
    },
    {
      type: 'symbol',
      encode: { enter: {
        x: { value: x + 11 }, y: { value: y + 6 },
        shape: { value: 'circle' }, size: { value: 40 },
        fill: { value: color }, stroke: { value: color }
      }}
    },
    {
      type: 'text',
      encode: { enter: {
        x: { value: x + 26 }, y: { value: y + 10 },
        text: { value: label }, fontSize: { value: 10 },
        fill: { value: '#333' }, baseline: { value: 'middle' }
      }}
    }
  ];
}

function barLegend(x, y, color, label) {
  return [
    {
      type: 'rect',
      encode: { enter: {
        x: { value: x }, x2: { value: x + 14 },
        y: { value: y }, y2: { value: y + 12 },
        fill: { value: color }
      }}
    },
    {
      type: 'text',
      encode: { enter: {
        x: { value: x + 18 }, y: { value: y + 10 },
        text: { value: label }, fontSize: { value: 10 },
        fill: { value: '#333' }, baseline: { value: 'middle' }
      }}
    }
  ];
}

// ─── DATA LABEL HELPERS ───────────────────────────────────────────────────────
function dataLabels(dataRef, xSignal, yScale, field, fmt = null, yOffset = -8) {
  return {
    type: 'text',
    from: { data: dataRef },
    encode: {
      enter: {
        x: { signal: xSignal },
        y: { scale: yScale, field, offset: yOffset },
        text: fmt
          ? { signal: `format(datum.${field}, '${fmt}')` }
          : { signal: `datum.${field} >= 1000 ? format(datum.${field}/1000, '.1f') + 'K' : format(datum.${field}, '.2f')` },
        fontSize: { value: 9 },
        fill: { value: '#333' },
        align: { value: 'center' },
        baseline: { value: 'bottom' }
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 1: Profitability Combo  (FSTB1B + FSTB3A)
//   Left axis  → Net Revenue bars
//   Right axis → EBITDA margin % + PAT margin % lines
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderProfitabilityComboChart(profData, plData) {
  const years      = getYearCols(profData);
  const revenueRow = findRow(plData, ['net revenue', 'revenue']);
  const patRow     = findRow(profData, ['profit margin', 'pat margin', 'net profit margin']);
  const ebitdaRow  = findRow(profData, ['ebitda margin', 'ebitda']);

  const tableData = years.map(y => ({
    year:    y,
    revenue: safeNum(revenueRow?.[y]),
    pat:     safeNum(patRow?.[y]),
    ebitda:  safeNum(ebitdaRow?.[y]),
  }));

  const maxRev      = Math.max(...tableData.map(d => d.revenue)) * 1.25 || 100;
  const marginVals  = tableData.flatMap(d => [d.pat, d.ebitda]);
  const [marginMin, marginMax] = adaptiveDomain(marginVals);

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 500, height: 250,
    padding: { left: 65, right: 60, top: 25, bottom: 60 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x',    type: 'band',   domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.35 },
      { name: 'ybar',  domain: [0, maxRev],              nice: true, range: 'height' },
      { name: 'yline', domain: [marginMin, marginMax],   nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x',     orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'ybar',  orient: 'left',   title: '₹ Lacs',   titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, format: '~s', tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true },
      { scale: 'yline', orient: 'right',  title: '%',        titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc' }
    ],
    marks: [
      // Revenue bars
      { type: 'rect', from: { data: 'table' }, encode: { enter: {
        x: { scale: 'x', field: 'year' }, width: { scale: 'x', band: 1 },
        y: { scale: 'ybar', field: 'revenue' }, y2: { scale: 'ybar', value: 0 },
        fill: { value: EY.silver }
      }}},
      // Revenue data labels
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'ybar', field: 'revenue', offset: -5 },
        text: { signal: "datum.revenue >= 100000 ? format(datum.revenue/1000,',.0f')+'K' : format(datum.revenue,',.0f')" },
        align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#555' }
      }}},
      // EBITDA margin line
      { type: 'line', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'ebitda' },
        stroke: { value: EY.grey }, strokeWidth: { value: 2 },
        strokeDash: { value: [5, 3] }
      }}},
      { type: 'symbol', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'ebitda' },
        fill: { value: EY.grey }, size: { value: 55 }
      }}},
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'ebitda', offset: -10 },
        text: { signal: "format(datum.ebitda,'.2f')+'%'" },
        align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#444' }
      }}},
      // PAT margin line
      { type: 'line', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'pat' },
        stroke: { value: EY.yellow }, strokeWidth: { value: 2.5 }
      }}},
      { type: 'symbol', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'pat' },
        fill: { value: EY.yellow }, size: { value: 55 }
      }}},
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'yline', field: 'pat', offset: 16 },
        text: { signal: "format(datum.pat,'.2f')+'%'" },
        align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#333' }
      }}},
      // Legend group
      { type: 'group', marks: [
        ...barLegend(0,  0, EY.silver, 'Net Revenue'),
        ...legendMark(130, 0, EY.grey,   'EBITDA Margin', true),
        ...legendMark(270, 0, EY.yellow, 'PAT Margin'),
      ], encode: { enter: { x: { value: 10 }, y: { signal: 'height + 30' } }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 2: ROA & ROCE line chart (FSTB1B)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderROARoceChart(profData) {
  const years   = getYearCols(profData);
  const roeRow  = findRow(profData, ['roe', 'return on equity']);
  const roaRow  = findRow(profData, ['roa', 'return on asset']);
  const roceRow = findRow(profData, ['roce', 'return on capital']);

  const tableData = years.map(y => ({
    year: y,
    roe:  safeNum(roeRow?.[y]),
    roa:  safeNum(roaRow?.[y]),
    roce: safeNum(roceRow?.[y]),
  }));

  const [roaDomMin, roaDomMax] = adaptiveDomain(tableData.flatMap(d => [d.roe, d.roa, d.roce]));

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 500, height: 230,
    padding: { left: 55, right: 20, top: 25, bottom: 60 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x',  type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.35 },
      { name: 'y',  domain: [roaDomMin, roaDomMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Percentage (%)', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true },
      // Zero-line reference when negative values exist
      ...(roaDomMin < 0 ? [{ scale: 'y', orient: 'left', domain: false, ticks: false, labels: false, grid: true, gridColor: '#888', gridWidth: 1, values: [0] }] : [])
    ],
    marks: [
      ...['roce', 'roa'].map((field, i) => {
        const color  = [EY.navy, EY.grey][i];
        const label  = ['ROCE', 'ROA'][i];
        const isDash = i === 1;
        return [
          { type: 'line', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            stroke: { value: color }, strokeWidth: { value: 2.5 },
            strokeDash: isDash ? { value: [5, 3] } : { value: [] }
          }}},
          { type: 'symbol', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            fill: { value: color }, size: { value: 55 }
          }}},
          { type: 'text', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field, offset: isDash ? 16 : -10 },
            text: { signal: `format(datum.${field},'.2f')+'%'` },
            align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#444' }
          }}}
        ];
      }).flat(),
      { type: 'group', marks: [
        ...legendMark(0,   0, EY.navy, 'ROCE'),
        ...legendMark(100, 0, EY.grey, 'ROA', true),
      ], encode: { enter: { x: { value: 30 }, y: { signal: 'height + 28' } }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 3: Liquidity (FSTB1C) — multi-line: Current, Quick, Cash
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderLiquidityChart(liquidityData) {
  const years   = getYearCols(liquidityData);
  const curRow  = findRow(liquidityData, ['current ratio']);
  const qkRow   = findRow(liquidityData, ['quick ratio']);
  const cashRow = findRow(liquidityData, ['cash ratio']);

  const tableData = years.map(y => ({
    year:    y,
    current: safeNum(curRow?.[y]),
    quick:   safeNum(qkRow?.[y]),
    cash:    safeNum(cashRow?.[y]),
  }));

  const [liqMin, liqMax] = adaptiveDomain(tableData.flatMap(d => [d.current, d.quick, d.cash]), 0);

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 550, height: 250,
    padding: { left: 55, right: 20, top: 25, bottom: 65 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x', type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.35 },
      { name: 'y', domain: [liqMin, liqMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Ratio Value', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickCount: 6, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true }
    ],
    marks: [
      ...['current', 'quick', 'cash'].map((field, i) => {
        const color   = [EY.yellow, EY.navy, EY.darkGrey][i];
        const label   = ['Current Ratio', 'Quick Ratio', 'Cash Ratio'][i];
        const isDash  = i === 0;
        const yOff    = [16, -10, 16][i];
        return [
          { type: 'line', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            stroke: { value: color }, strokeWidth: { value: 2.2 },
            strokeDash: isDash ? { value: [5, 3] } : { value: [] }
          }}},
          { type: 'symbol', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            fill: { value: color }, size: { value: 50 }
          }}},
          { type: 'text', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field, offset: yOff },
            text: { signal: `format(datum.${field}, '.2f')` },
            align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#333' }
          }}}
        ];
      }).flat(),
      { type: 'group', marks: [
        ...legendMark(0,   0, EY.yellow,  'Current Ratio', true),
        ...legendMark(130, 0, EY.navy,    'Quick Ratio'),
        ...legendMark(260, 0, EY.darkGrey,'Cash Ratio', true),
      ], encode: { enter: { x: { value: 10 }, y: { signal: 'height + 32' } }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 4: Operating Cycle — Creditor & Debtor days (line)  (FSTB1D)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderOperatingCycleChart(ocData) {
  const years    = getYearCols(ocData);
  const credRow  = findRow(ocData, ['creditor', 'creditors day']);
  const debtRow  = findRow(ocData, ['debtor', 'debtors day']);
  const invRow   = findRow(ocData, ['inventory']);

  const tableData = years.map(y => ({
    year:     y,
    creditor: safeNum(credRow?.[y]),
    debtor:   safeNum(debtRow?.[y]),
    inventory: safeNum(invRow?.[y]),
  }));

  const [ocMin, ocMax] = adaptiveDomain(tableData.flatMap(d => [d.creditor, d.debtor, d.inventory]), 0);

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 500, height: 230,
    padding: { left: 60, right: 20, top: 25, bottom: 65 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x', type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.35 },
      { name: 'y', domain: [ocMin, ocMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Days', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true }
    ],
    marks: [
      ...['creditor', 'debtor', 'inventory'].map((field, i) => {
        const color  = [EY.navy, EY.grey, EY.orange][i];
        const label  = ['Creditor Days', 'Debtor Days', 'Inventory Days'][i];
        const isDash = [false, false, true][i];
        const yOff   = [16, -10, -10][i];
        return [
          { type: 'line', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            stroke: { value: color }, strokeWidth: { value: 2.2 },
            strokeDash: isDash ? { value: [5, 3] } : { value: [] }
          }}},
          { type: 'symbol', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field },
            fill: { value: color }, size: { value: 50 }
          }}},
          { type: 'text', from: { data: 'table' }, encode: { enter: {
            x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
            y: { scale: 'y', field, offset: yOff },
            text: { signal: `format(datum.${field}, '.0f')` },
            align: { value: 'center' }, fontSize: { value: 9 }, fill: { value: '#333' }
          }}}
        ];
      }).flat(),
      { type: 'group', marks: [
        ...legendMark(0,   0, EY.navy,  'Creditor Days'),
        ...legendMark(130, 0, EY.grey,  'Debtor Days'),
        ...legendMark(255, 0, EY.orange,'Inventory Days', true),
      ], encode: { enter: { x: { value: 10 }, y: { signal: 'height + 32' } }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 5: Asset Turnover Ratio bar chart (from FSTB1D data)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderAssetTurnoverChart(ocData) {
  const years  = getYearCols(ocData);
  const atrRow = findRow(ocData, ['asset turnover']);
  if (!atrRow) return null;

  const tableData = years.map(y => ({ year: y, atr: safeNum(atrRow[y]) }));
  const maxVal    = Math.max(...tableData.map(d => d.atr)) * 1.4 || 5;

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 380, height: 210,
    padding: { left: 55, right: 20, top: 20, bottom: 50 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x', type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.4 },
      { name: 'y', domain: [derDomMin, derDomMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Ratio', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true }
    ],
    marks: [
      { type: 'rect', from: { data: 'table' }, encode: { enter: {
        x: { scale: 'x', field: 'year' }, width: { scale: 'x', band: 1 },
        y: { scale: 'y', field: 'atr' },  y2: { scale: 'y', value: 0 },
        fill: { value: EY.lightGrey }
      }}},
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'y', field: 'atr', offset: -6 },
        text: { signal: "format(datum.atr,'.2f')" },
        align: { value: 'center' }, fontSize: { value: 10 }, fill: { value: '#333' }
      }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 6: Debt-Equity Ratio bar chart (FSTB1E)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderDebtEquityChart(capData) {
  const years   = getYearCols(capData);
  const derRow  = findRow(capData, ['debt equity', 'debt-equity', 'd/e']);
  if (!derRow) return null;

  const tableData = years.map(y => ({ year: y, der: safeNum(derRow[y]) }));
  const [derDomMin, derDomMax] = adaptiveDomain(tableData.map(d => d.der), 0);

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 380, height: 210,
    padding: { left: 55, right: 20, top: 20, bottom: 50 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x', type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.4 },
      { name: 'y', domain: [derDomMin, derDomMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Ratio', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true }
    ],
    marks: [
      { type: 'rect', from: { data: 'table' }, encode: { enter: {
        x: { scale: 'x', field: 'year' }, width: { scale: 'x', band: 1 },
        y: { scale: 'y', field: 'der' },  y2: { scale: 'y', value: 0 },
        fill: { value: EY.lightGrey }
      }}},
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'y', field: 'der', offset: -6 },
        text: { signal: "format(datum.der,'.2f')" },
        align: { value: 'center' }, fontSize: { value: 10 }, fill: { value: '#333' }
      }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART 7: Interest Coverage Ratio bar chart (FSTB1E)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderInterestCoverageChart(capData) {
  const years   = getYearCols(capData);
  const icrRow  = findRow(capData, ['interest coverage', 'icr']);
  if (!icrRow) return null;

  const tableData = years.map(y => ({ year: y, icr: safeNum(icrRow[y]) }));
  const [icrDomMin, icrDomMax] = adaptiveDomain(tableData.map(d => d.icr));

  const spec = {
    "$schema": "https://vega.github.io/schema/vega/v5.json",
    width: 380, height: 210,
    padding: { left: 55, right: 20, top: 20, bottom: 50 },
    background: 'white',
    data: [{ name: 'table', values: tableData }],
    scales: [
      { name: 'x', type: 'band',  domain: { data: 'table', field: 'year' }, range: 'width', padding: 0.4 },
      { name: 'y', domain: [icrDomMin, icrDomMax], nice: true, range: 'height' }
    ],
    axes: [
      { scale: 'x', orient: 'bottom', labelFont: 'Arial', labelFontSize: 11, tickColor: '#999', domainColor: '#999' },
      { scale: 'y', orient: 'left',   title: 'Times', titleFont: 'Arial', titleFontSize: 11, labelFontSize: 10, tickColor: '#ccc', domainColor: '#ccc', gridColor: '#eee', grid: true }
    ],
    marks: [
      { type: 'rect', from: { data: 'table' }, encode: { enter: {
        x: { scale: 'x', field: 'year' }, width: { scale: 'x', band: 1 },
        y: { scale: 'y', field: 'icr' },  y2: { scale: 'y', value: 0 },
        fill: { value: EY.lightGrey }
      }}},
      { type: 'text', from: { data: 'table' }, encode: { enter: {
        x: { signal: "scale('x', datum.year) + bandwidth('x')/2" },
        y: { scale: 'y', field: 'icr', offset: -6 },
        text: { signal: "format(datum.icr,'.2f')" },
        align: { value: 'center' }, fontSize: { value: 10 }, fill: { value: '#333' }
      }}}
    ]
  };

  return renderVegaSpec(spec);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER: pre-generate all financial charts from financial_data array
// Returns: { FSTB1B: { combo, roa }, FSTB1C: { liquidity }, FSTB1D: { oc, atr }, FSTB1E: { de, icr } }
// ═══════════════════════════════════════════════════════════════════════════════
export async function generateFinancialCharts(financialData) {
  const find = (code) => {
    const kpi = financialData.find(k => k.kpi_code === code);
    if (!kpi) return null;
    try { return JSON.parse(kpi.kpi_details); } catch { return null; }
  };

  const profData = find('FSTB1B');
  const plData   = find('FSTB3A');
  const liqData  = find('FSTB1C');
  const ocData   = find('FSTB1D');
  const capData  = find('FSTB1E');

  const charts = {};

  if (profData) {
    charts['FSTB1B'] = {
      combo: plData ? await renderProfitabilityComboChart(profData, plData).catch(() => null) : null,
      roa:   await renderROARoceChart(profData).catch(() => null),
    };
  }

  if (liqData) {
    charts['FSTB1C'] = {
      liquidity: await renderLiquidityChart(liqData).catch(() => null),
    };
  }

  if (ocData) {
    charts['FSTB1D'] = {
      oc:  await renderOperatingCycleChart(ocData).catch(() => null),
      atr: await renderAssetTurnoverChart(ocData).catch(() => null),
    };
  }

  if (capData) {
    charts['FSTB1E'] = {
      de:  await renderDebtEquityChart(capData).catch(() => null),
      icr: await renderInterestCoverageChart(capData).catch(() => null),
    };
  }

  return charts;
}