// Dependency-free helpers injected into every JS recipe's scope. Two jobs:
//   1. data-cleanup utilities — the pandas robustness we lose (numbers hidden in
//      "$1,200" strings, dates in mixed formats). Registered as Arquero ops so
//      recipes can call them inside table expressions: op.parseNumber(d.Amount).
//   2. Plotly figure builders — return plain dicts; Plotly.js renders them on the
//      main thread, exactly as today. Recipes never import a charting library.
import * as aq from "arquero";

/** "$1,200.50" | "1,200" | 1200 -> 1200 ; blank/unparseable -> NaN. */
export function parseNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const cleaned = String(v).trim().replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return NaN;
  return parseFloat(cleaned);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function mk(y: number, mo: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, mo, d));
  return isNaN(+dt) ? null : dt;
}

/** Parse mixed real-world date formats (ISO, M/D/Y, "Jan 5, 2024") -> Date | null. */
export function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(+v) ? null : v;
  if (v == null) return null;
  if (typeof v === "number") { const d = new Date(v); return isNaN(+d) ? null : d; }
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);        // 2024-01-05 / 2024/1/5
  if (m) return mk(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);            // 01/05/2024 (US)
  if (m) return mk(+m[3], +m[1] - 1, +m[2]);
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i); // Jan 5, 2024
  if (m && m[1].toLowerCase() in MONTHS) return mk(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/i);   // 5 Jan 2024
  if (m && m[2].toLowerCase() in MONTHS) return mk(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  const d = new Date(s);
  return isNaN(+d) ? null : d;
}

/** "2024-03" month key for time-series grouping; null if unparseable. */
export function yearMonth(v: unknown): string | null {
  const d = parseDate(v);
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
}

// --- Plotly figure builders (plain dicts, no plotly import) --------------------
type PlotOpts = { title?: string; xlabel?: string; ylabel?: string };
function layout(o: PlotOpts) {
  const l: Record<string, unknown> = {};
  if (o.title) l.title = { text: o.title };
  if (o.xlabel) l.xaxis = { title: { text: o.xlabel } };
  if (o.ylabel) l.yaxis = { title: { text: o.ylabel } };
  return l;
}
export function plotBar(x: unknown[], y: unknown[], o: PlotOpts = {}) {
  return { data: [{ type: "bar", x: [...x], y: [...y] }], layout: layout(o) };
}
export function plotLine(x: unknown[], y: unknown[], o: PlotOpts = {}) {
  return { data: [{ type: "scatter", mode: "lines+markers", x: [...x], y: [...y] }], layout: layout(o) };
}
export function plotScatter(x: unknown[], y: unknown[], o: PlotOpts = {}) {
  return { data: [{ type: "scatter", mode: "markers", x: [...x], y: [...y] }], layout: layout(o) };
}
export function plotPie(labels: unknown[], values: unknown[], o: PlotOpts = {}) {
  return { data: [{ type: "pie", labels: [...labels], values: [...values] }], layout: layout({ title: o.title }) };
}

/** Register cleanup helpers as Arquero ops (idempotent) so recipes can use them
 * inside table expressions, e.g. .derive({ amt: d => op.parseNumber(d.Amount) }). */
let registered = false;
export function registerOps(): void {
  if (registered) return;
  registered = true;
  aq.addFunction("parseNumber", parseNumber, { override: true });
  aq.addFunction("parseDate", (v: unknown) => { const d = parseDate(v); return d ? +d : null; }, { override: true });
  aq.addFunction("yearMonth", yearMonth, { override: true });
}
