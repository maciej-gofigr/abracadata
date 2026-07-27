// The JS recipe runtime. Compiles a recipe's `transform(inputs, params)` source
// and runs it with Arquero + the helper stdlib injected into scope, returning the
// full result tables (rows) + plot figures. `toPreview` derives the capped,
// typed preview the UI renders.
//
// Recipe contract (the v2 JS contract):
//   function transform(inputs, params) {
//     // inputs.<alias> is an Arquero table; params holds knob values.
//     return { tables: { "Name": <Arquero table | array of row objects>, ... },
//              plots:  { "Name": plotBar(...)|plotLine(...)|..., ... } };
//   }
//
// This module is runtime-only (no DOM). It runs inside the data worker, which
// strips network globals before any recipe executes (see jsWorker.ts).
import * as aq from "arquero";
import type { TablePreview } from "../types";
import * as stdlib from "./recipeStdlib";

export type Row = Record<string, unknown>;
export interface RuntimeTable { name: string; columns: string[]; rows: Row[]; }
export interface RuntimeResult { tables: RuntimeTable[]; plots: { name: string; figure: unknown }[]; }

function isArqueroTable(v: unknown): v is { objects: () => Row[]; columnNames: () => string[] } {
  return !!v && typeof (v as { objects?: unknown }).objects === "function"
    && typeof (v as { columnNames?: unknown }).columnNames === "function";
}

function asTable(name: string, value: unknown): RuntimeTable {
  if (isArqueroTable(value)) return { name, columns: value.columnNames(), rows: value.objects() };
  if (Array.isArray(value)) {
    const columns = value.length ? Object.keys(value[0] as object) : [];
    return { name, columns, rows: value as Row[] };
  }
  throw new Error(`Table "${name}" must be an Arquero table or an array of row objects.`);
}

export function runRecipe(source: string, inputRows: Record<string, Row[]>, params: Row = {}): RuntimeResult {
  stdlib.registerOps();

  const inputs: Record<string, unknown> = {};
  for (const [alias, rows] of Object.entries(inputRows)) inputs[alias] = aq.from(rows);

  const scope: Record<string, unknown> = {
    aq,
    op: aq.op,
    col: stdlib.col,
    parseNumber: stdlib.parseNumber,
    parseDate: stdlib.parseDate,
    yearMonth: stdlib.yearMonth,
    plotBar: stdlib.plotBar,
    plotLine: stdlib.plotLine,
    plotScatter: stdlib.plotScatter,
    plotPie: stdlib.plotPie,
  };
  const names = Object.keys(scope);
  const body = `"use strict";\n${source}\n;\nif (typeof transform !== "function") throw new Error("Your recipe must define a transform(inputs, params) function.");\nreturn transform(inputs, params);`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("inputs", "params", ...names, body) as (
    inputs: unknown, params: unknown, ...rest: unknown[]
  ) => { tables?: Record<string, unknown>; plots?: Record<string, unknown> };

  const result = fn(inputs, params, ...names.map((n) => scope[n]));
  if (!result || typeof result !== "object") throw new Error("transform must return a { tables, plots } object.");

  const tables = Object.entries(result.tables ?? {}).map(([name, v]) => asTable(name, v));
  const plots = Object.entries(result.plots ?? {}).map(([name, figure]) => {
    if (!figure || typeof figure !== "object" || !Array.isArray((figure as { data?: unknown }).data)) {
      throw new Error(`Plot "${name}" must be a Plotly figure with a data array — use plotBar/plotLine/… or return { data: [...], layout: {...} }.`);
    }
    return { name, figure };
  });
  if (tables.length === 0) throw new Error("A recipe must return at least one table.");
  return { tables, plots };
}

/** Infer a simple display type for a column from its values. */
function inferDtype(rows: Row[], col: string): string {
  for (const r of rows) {
    const v = r[col];
    if (v == null || v === "") continue;
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "boolean";
    return "string";
  }
  return "string";
}

/** Capped, typed preview for the UI (rows as arrays, matching the old contract). */
export function toPreview(columns: string[], rows: Row[], maxRows = 50): TablePreview {
  return {
    columns,
    dtypes: columns.map((c) => inferDtype(rows, c)),
    rows: rows.slice(0, maxRows).map((r) => columns.map((c) => normalizeCell(r[c]))),
    rowCount: rows.length,
  };
}

/** JSON-safe scalar for transport/display (Dates -> ISO, undefined -> null). */
export function normalizeCell(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return isNaN(+v) ? null : v.toISOString();
  return v;
}
