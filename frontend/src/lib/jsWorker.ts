// Web worker that owns the recipe runtime. All recipe execution + file parsing
// happens here so the UI thread never blocks, and — since a recipe is LLM- or
// shared-authored JS run via new Function — the worker is also the sandbox:
//
//   * Workers have no DOM: no document, cookies, or localStorage to touch.
//   * We remove every network primitive below, BEFORE any recipe runs, so a
//     malicious (e.g. shared) recipe cannot exfiltrate the user's data. The app
//     also ships a `connect-src 'self'` CSP as defense-in-depth.
//
// v2 JS recipe contract:
//   function transform(inputs, params) -> { tables: {name: table|rows}, plots: {name: fig} }
// inputs.<alias> is an Arquero table; charts are built with the injected plot* helpers.
import { runRecipe, toPreview, type Row } from "./recipeRuntime";
import { parseFile, distinctValues, previewRows, columnProfile } from "./recipeData";
import Papa from "papaparse";

// --- Sandbox: strip network egress from the worker global scope ---------------
for (const g of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Request", "Response"]) {
  try { delete (self as unknown as Record<string, unknown>)[g]; } catch { /* non-configurable */ }
  try { (self as unknown as Record<string, unknown>)[g] = undefined; } catch { /* frozen */ }
}
try { (self as unknown as { navigator?: { sendBeacon?: unknown } }).navigator!.sendBeacon = undefined; } catch { /* no navigator */ }

interface Dataset { columns: string[]; rows: Row[]; }
const state: { inputs: Record<string, Dataset>; outputs: Record<string, Dataset> } = { inputs: {}, outputs: {} };

interface WorkerRequest {
  id: number;
  type:
    | "init" | "clearInputs" | "loadInput" | "renameInput" | "removeInput"
    | "distinctValues" | "runScript" | "exportTable"
    | "previewRows" | "columnProfile" | "runRecipeTest";
  alias?: string;
  oldAlias?: string;
  name?: string;
  buffer?: ArrayBuffer;
  script?: string;
  params?: string;
  table?: string;
  column?: string;
  n?: number;
  limit?: number;
  includeValues?: boolean;
}

// Agent-tool calls resolve with the full result (including {ok:false} errors, so
// the loop can feed a failure back to the model); other ops reject on failure.
const TOOL_TYPES = new Set(["previewRows", "columnProfile", "runRecipeTest"]);

const ctx = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? (e.stack?.split("\n").slice(0, 4).join("\n") || e.message) : String(e);
}

type Result = Record<string, unknown> & { ok: boolean };

function handle(msg: WorkerRequest): Result {
  switch (msg.type) {
    case "clearInputs":
      state.inputs = {}; state.outputs = {}; return { ok: true };
    case "loadInput": {
      const { columns, rows } = parseFile(msg.name!, msg.buffer!);
      state.inputs[msg.alias!] = { columns, rows };
      return { ok: true, preview: toPreview(columns, rows) };
    }
    case "renameInput":
      if (msg.oldAlias !== msg.alias && state.inputs[msg.oldAlias!]) {
        state.inputs[msg.alias!] = state.inputs[msg.oldAlias!];
        delete state.inputs[msg.oldAlias!];
      }
      return { ok: true };
    case "removeInput":
      delete state.inputs[msg.alias!]; return { ok: true };
    case "distinctValues": {
      const ds = state.inputs[msg.alias!];
      return { ok: true, values: ds ? distinctValues(ds.columns, ds.rows, msg.column!, msg.limit ?? 100) : [] };
    }
    case "runScript": {
      const params = msg.params ? JSON.parse(msg.params) : {};
      const inputRows = Object.fromEntries(Object.entries(state.inputs).map(([a, d]) => [a, d.rows]));
      const res = runRecipe(msg.script!, inputRows, params);
      state.outputs = Object.fromEntries(res.tables.map((t) => [t.name, { columns: t.columns, rows: t.rows }]));
      return {
        ok: true,
        tables: res.tables.map((t) => ({ name: t.name, preview: toPreview(t.columns, t.rows) })),
        plots: res.plots,
      };
    }
    case "exportTable": {
      const ds = state.outputs[msg.table!];
      if (!ds) return { ok: false, error: `No output table named "${msg.table}".` };
      const csv = Papa.unparse(ds.rows.map((r) => Object.fromEntries(ds.columns.map((c) => [c, r[c]]))), { columns: ds.columns });
      return { ok: true, csv };
    }
    case "previewRows": {
      const ds = state.inputs[msg.alias!];
      if (!ds) return { ok: false, error: `No input named "${msg.alias}". Available: ${Object.keys(state.inputs).join(", ")}` };
      return previewRows(ds.columns, ds.rows, msg.n ?? 5);
    }
    case "columnProfile": {
      const ds = state.inputs[msg.alias!];
      if (!ds) return { ok: false, error: `No input named "${msg.alias}".` };
      return columnProfile(ds.columns, ds.rows, msg.column!);
    }
    case "runRecipeTest": {
      const params = msg.params ? JSON.parse(msg.params) : {};
      const inputRows = Object.fromEntries(Object.entries(state.inputs).map(([a, d]) => [a, d.rows]));
      const res = runRecipe(msg.script!, inputRows, params);
      return {
        ok: true,
        tables: res.tables.map((t) => ({
          name: t.name,
          columns: t.columns,
          row_count: t.rows.length,
          ...(msg.includeValues ? { head: t.rows.slice(0, 5) } : {}),
        })),
        plots: res.plots.map((p) => p.name),
      };
    }
    default:
      return { ok: false, error: `Unknown request: ${msg.type}` };
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") { ctx.postMessage({ id: msg.id, ok: true, payload: null }); return; }
  try {
    const result = handle(msg);
    if (TOOL_TYPES.has(msg.type) || result.ok !== false) {
      ctx.postMessage({ id: msg.id, ok: true, payload: result });
    } else {
      ctx.postMessage({ id: msg.id, ok: false, error: result.error });
    }
  } catch (err) {
    // Runtime/parse errors: reject non-tool ops; hand tool ops the error to relay.
    if (TOOL_TYPES.has(msg.type)) {
      ctx.postMessage({ id: msg.id, ok: true, payload: { ok: false, error: errMsg(err) } });
    } else {
      ctx.postMessage({ id: msg.id, ok: false, error: errMsg(err) });
    }
  }
};
