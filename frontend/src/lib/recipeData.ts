// Pure data functions used by the data worker: file parsing (CSV via Papa Parse,
// Excel via SheetJS) and the read-only agent tools (preview rows, column profile,
// distinct values). No DOM, no state — the worker owns state and calls these.
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { normalizeCell, type Row } from "./recipeRuntime";

export interface Parsed { columns: string[]; rows: Row[]; }

function normalizeRows(rows: Row[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const k of Object.keys(r)) out[k] = normalizeCell(r[k]);
    return out;
  });
}

/** Parse a CSV or Excel file (by extension) into ordered columns + row objects. */
export function parseFile(name: string, buffer: ArrayBuffer): Parsed {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { columns: [], rows: [] };
    const header = (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false })[0] as unknown[]) ?? [];
    const columns = header.map((h) => String(h));
    const rows = normalizeRows(XLSX.utils.sheet_to_json<Row>(ws, { defval: null }));
    return { columns, rows };
  }
  const text = new TextDecoder("utf-8").decode(buffer);
  const parsed = Papa.parse<Row>(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  const columns = parsed.meta.fields ?? (parsed.data[0] ? Object.keys(parsed.data[0]) : []);
  return { columns, rows: normalizeRows(parsed.data) };
}

/** Distinct non-empty string values of a column (case-insensitive match), for a param dropdown. */
export function distinctValues(columns: string[], rows: Row[], column: string, limit = 100): string[] {
  const col = columns.find((c) => c.trim().toLowerCase() === String(column).trim().toLowerCase());
  if (!col) return [];
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[col];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) seen.add(s);
  }
  return [...seen].sort().slice(0, Math.max(0, limit || 100));
}

/** First n rows (1..20) as arrays — the preview_rows agent tool. */
export function previewRows(columns: string[], rows: Row[], n: number) {
  const k = Math.max(1, Math.min(Math.floor(n || 5), 20));
  return {
    ok: true as const,
    columns,
    rows: rows.slice(0, k).map((r) => columns.map((c) => normalizeCell(r[c]))),
    row_count: rows.length,
  };
}

/** Numeric or categorical profile of one column — the column_profile agent tool. */
export function columnProfile(columns: string[], rows: Row[], column: string) {
  if (!columns.includes(column)) {
    return { ok: false as const, error: `No column "${column}". Columns: ${columns.join(", ")}` };
  }
  const values = rows.map((r) => r[column]);
  const nonNull = values.filter((v) => v != null && v !== "");
  const nullCount = values.length - nonNull.length;
  const allNumeric = nonNull.length > 0 && nonNull.every((v) => typeof v === "number");

  const base = { ok: true as const, column, null_count: nullCount, count: values.length };
  if (allNumeric) {
    const nums = nonNull as number[];
    return {
      ...base,
      kind: "numeric" as const,
      dtype: "number",
      min: Math.min(...nums),
      max: Math.max(...nums),
      mean: nums.reduce((a, b) => a + b, 0) / nums.length,
    };
  }
  const counts = new Map<string, number>();
  for (const v of nonNull) {
    const s = String(v).trim();
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  return {
    ...base,
    kind: "categorical" as const,
    dtype: "string",
    unique_count: counts.size,
    top_values: top.map(([value, count]) => ({ value, count })),
  };
}
