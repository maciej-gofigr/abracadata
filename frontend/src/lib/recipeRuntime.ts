// The JS recipe runtime (spike). Compiles a recipe's `transform(inputs, params)`
// source and runs it with Arquero + the helper stdlib injected into scope, then
// normalizes the returned tables/plots into previews the UI can render.
//
// Recipe contract (JS analogue of the v2 pandas contract):
//   function transform(inputs, params) {
//     // inputs.<alias> is an Arquero table; params holds knob values.
//     return { tables: { "Name": <Arquero table | array of row objects>, ... },
//              plots:  { "Name": plotBar(...)|plotLine(...)|..., ... } };
//   }
//
// In the real app this runs inside a web worker (no DOM) with network globals
// stripped — see the security note in the port plan. Here it's a plain module so
// it can be unit-tested headlessly.
import * as aq from "arquero";
import * as stdlib from "./recipeStdlib";

export interface RuntimePreview {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}
export interface RuntimeResult {
  tables: { name: string; preview: RuntimePreview }[];
  plots: { name: string; figure: unknown }[];
}

function isArqueroTable(v: unknown): v is { objects: () => Record<string, unknown>[]; columnNames: () => string[] } {
  return !!v && typeof (v as { objects?: unknown }).objects === "function"
    && typeof (v as { columnNames?: unknown }).columnNames === "function";
}

function toPreview(value: unknown, maxRows = 50): RuntimePreview {
  if (isArqueroTable(value)) {
    const columns = value.columnNames();
    const objs = value.objects();
    return { columns, rows: objs.slice(0, maxRows).map((o) => columns.map((c) => o[c])), rowCount: objs.length };
  }
  if (Array.isArray(value)) {
    const columns = value.length ? Object.keys(value[0] as object) : [];
    return { columns, rows: value.slice(0, maxRows).map((o) => columns.map((c) => (o as Record<string, unknown>)[c])), rowCount: value.length };
  }
  throw new Error("Each recipe table must be an Arquero table or an array of row objects.");
}

export function runRecipe(
  source: string,
  inputRows: Record<string, Record<string, unknown>[]>,
  params: Record<string, unknown> = {},
): RuntimeResult {
  stdlib.registerOps();

  const inputs: Record<string, unknown> = {};
  for (const [alias, rows] of Object.entries(inputRows)) inputs[alias] = aq.from(rows);

  const scope: Record<string, unknown> = {
    aq,
    op: aq.op,
    parseNumber: stdlib.parseNumber,
    parseDate: stdlib.parseDate,
    yearMonth: stdlib.yearMonth,
    plotBar: stdlib.plotBar,
    plotLine: stdlib.plotLine,
    plotScatter: stdlib.plotScatter,
    plotPie: stdlib.plotPie,
  };
  const names = Object.keys(scope);
  const body = `"use strict";\n${source}\n;\nreturn transform(inputs, params);`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("inputs", "params", ...names, body) as (
    inputs: unknown, params: unknown, ...rest: unknown[]
  ) => { tables?: Record<string, unknown>; plots?: Record<string, unknown> };

  const result = fn(inputs, params, ...names.map((n) => scope[n]));
  if (!result || typeof result !== "object") throw new Error("transform must return { tables, plots }.");

  const tables = Object.entries(result.tables ?? {}).map(([name, v]) => ({ name, preview: toPreview(v) }));
  const plots = Object.entries(result.plots ?? {}).map(([name, figure]) => ({ name, figure }));
  if (tables.length === 0) throw new Error("A recipe must return at least one table.");
  return { tables, plots };
}
