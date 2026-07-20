import { useEffect, useState } from "react";
import { APP_NAME, APP_TAGLINE } from "./branding";
import { DataTable } from "./components/DataTable";
import { DropZone } from "./components/DropZone";
import { PlotView } from "./components/PlotView";
import { ScriptPanel } from "./components/ScriptPanel";
import { pyWorker } from "./lib/pyodide";
import { buildRecipe, parseRecipe } from "./lib/recipe";
import {
  SAMPLE_CUSTOMERS_CSV,
  SAMPLE_ORDERS_CSV,
  SAMPLE_PARAMS,
  SAMPLE_SCRIPT,
} from "./lib/fixtures";
import type {
  InputFile,
  RecipeMeta,
  RecipeParam,
  RunResult,
} from "./types";

type ParamValues = Record<string, string | number | boolean>;

export function App() {
  const [inputs, setInputs] = useState<InputFile[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [params, setParams] = useState<RecipeParam[]>([]);
  const [paramValues, setParamValues] = useState<ParamValues>({});
  const [output, setOutput] = useState<RunResult | null>(null);
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Start downloading Pyodide right away so the first file load is fast.
  useEffect(() => {
    pyWorker.warmUp();
  }, []);

  async function run(src: string, values: ParamValues, ins: InputFile[]) {
    if (!src || ins.length === 0) return;
    setRunning(true);
    setRunError(null);
    try {
      const result = await pyWorker.runScript(src, values);
      setOutput(result);
    } catch (err) {
      setOutput(null);
      setRunError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleFiles(files: File[]) {
    setFileError(null);
    let current = inputs;
    let loadedRecipe = false;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".py")) {
        loadedRecipe = (await loadRecipeFile(file)) || loadedRecipe;
      } else {
        const added = await loadDataFile(file, current);
        if (added) current = [...current.filter((i) => i.alias !== added.alias), added];
      }
    }
    setInputs(current);
    if (script && current.length && !loadedRecipe) {
      void run(script, paramValues, current);
    }
  }

  async function loadDataFile(
    file: File,
    current: InputFile[],
  ): Promise<InputFile | null> {
    setLoadingMsg(`Reading ${file.name}… (first load also fetches the Python runtime)`);
    try {
      const alias = uniqueAlias(aliasFromFilename(file.name), current);
      const buffer = await file.arrayBuffer();
      const { preview } = await pyWorker.loadInput(alias, file.name, buffer);
      return { alias, fileName: file.name, preview };
    } catch (err) {
      setFileError(errorMessage(err));
      return null;
    } finally {
      setLoadingMsg(null);
    }
  }

  async function loadRecipeFile(file: File): Promise<boolean> {
    const text = await file.text();
    const parsed = parseRecipe(text);
    if (!parsed) {
      setFileError(`${file.name} doesn't look like a recipe (no transform() found).`);
      return false;
    }
    setScript(parsed.script);
    const ps = parsed.meta?.params ?? [];
    setParams(ps);
    const values = defaultsOf(ps);
    setParamValues(values);
    if (inputs.length) void run(parsed.script, values, inputs);
    return true;
  }

  async function loadSample() {
    setFileError(null);
    setRunError(null);
    setOutput(null);
    setLoadingMsg("Loading sample files… (first load also fetches the Python runtime, ~10s)");
    try {
      await pyWorker.clearInputs();
      const enc = new TextEncoder();
      const ord = await pyWorker.loadInput("orders", "orders.csv", enc.encode(SAMPLE_ORDERS_CSV).buffer);
      const cus = await pyWorker.loadInput("customers", "customers.csv", enc.encode(SAMPLE_CUSTOMERS_CSV).buffer);
      const next: InputFile[] = [
        { alias: "orders", fileName: "orders.csv", preview: ord.preview },
        { alias: "customers", fileName: "customers.csv", preview: cus.preview },
      ];
      setInputs(next);
      setScript(SAMPLE_SCRIPT);
      setParams(SAMPLE_PARAMS);
      const values = defaultsOf(SAMPLE_PARAMS);
      setParamValues(values);
      await run(SAMPLE_SCRIPT, values, next);
    } catch (err) {
      setFileError(errorMessage(err));
    } finally {
      setLoadingMsg(null);
    }
  }

  function setParam(name: string, value: string | number | boolean) {
    const values = { ...paramValues, [name]: value };
    setParamValues(values);
    if (script) void run(script, values, inputs);
  }

  function reset() {
    setInputs([]);
    setScript(null);
    setParams([]);
    setParamValues({});
    setOutput(null);
    setRunError(null);
    setFileError(null);
    void pyWorker.clearInputs();
  }

  async function downloadTable(name: string) {
    const { csv } = await pyWorker.exportTable(name);
    downloadBlob(`${name.replace(/\s+/g, "_")}.csv`, csv, "text/csv");
  }

  function saveRecipe() {
    if (!script) return;
    const meta: RecipeMeta = {
      version: 2,
      name: "recipe",
      created: new Date().toISOString(),
      prompts: [],
      inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      params,
    };
    downloadBlob("recipe.py", buildRecipe(script, meta), "text/x-python");
  }

  const hasInputs = inputs.length > 0;

  return (
    <div className="app">
      <header>
        <div>
          <h1>{APP_NAME}</h1>
          <p className="tagline">{APP_TAGLINE}</p>
        </div>
        {hasInputs && (
          <button className="link-btn" onClick={reset}>
            Start over
          </button>
        )}
      </header>

      {!hasInputs && (
        <>
          <DropZone
            onFiles={handleFiles}
            label="Drop one or more CSV / Excel files (or a saved recipe .py)"
            hint="Everything runs in your browser — your data never leaves this machine."
          />
          <p className="sample-hint">
            No file handy?{" "}
            <button className="link-btn" onClick={loadSample}>
              Load sample files (orders + customers) →
            </button>
          </p>
        </>
      )}

      {loadingMsg && <div className="status">{loadingMsg}</div>}
      {fileError && <div className="error">{fileError}</div>}

      {hasInputs && (
        <>
          <section className="inputs-grid">
            {inputs.map((inp) => (
              <div className="card" key={inp.alias}>
                <div className="card-header">
                  <h2>
                    <span className="alias">{inp.alias}</span>{" "}
                    <span className="from-file">from {inp.fileName}</span>
                  </h2>
                  <span className="muted">
                    {inp.preview.rowCount.toLocaleString()} rows · {inp.preview.columns.length} cols
                  </span>
                </div>
                <DataTable preview={inp.preview} maxRows={6} />
              </div>
            ))}
            <DropZone onFiles={handleFiles} label="＋ Add another file" compact />
          </section>

          {params.length > 0 && (
            <section className="card params-card">
              <div className="card-header">
                <h2>Parameters</h2>
                <span className="muted">edits re-run instantly, in your browser</span>
              </div>
              <div className="params-grid">
                {params.map((p) => (
                  <ParamControl
                    key={p.name}
                    param={p}
                    value={paramValues[p.name]}
                    onChange={(v) => setParam(p.name, v)}
                  />
                ))}
              </div>
            </section>
          )}

          {running && <div className="status">Running…</div>}
          {runError && (
            <div className="run-error">
              <div className="run-error-title">That recipe didn't run:</div>
              <pre>{runError}</pre>
            </div>
          )}

          {output && (
            <section className="output">
              {output.tables.map((t) => (
                <div className="card" key={t.name}>
                  <div className="card-header">
                    <h2>{t.name}</h2>
                    <span className="muted">
                      {t.preview.rowCount.toLocaleString()} rows · {t.preview.columns.length} cols
                    </span>
                    <button onClick={() => downloadTable(t.name)}>Download CSV</button>
                  </div>
                  <DataTable preview={t.preview} />
                </div>
              ))}
              {output.plots.map((p) => (
                <PlotView key={p.name} spec={p} />
              ))}
            </section>
          )}

          <ScriptPanel
            script={script}
            running={running}
            canRun={hasInputs}
            onChange={setScript}
            onRun={() => script && run(script, paramValues, inputs)}
            onSaveRecipe={saveRecipe}
          />
        </>
      )}
    </div>
  );
}

function ParamControl({
  param,
  value,
  onChange,
}: {
  param: RecipeParam;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  return (
    <label className="param">
      <span className="param-label">
        {param.label}
        {param.help && <span className="param-help"> — {param.help}</span>}
      </span>
      {param.type === "enum" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(param.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : param.type === "bool" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : param.type === "number" || param.type === "currency" ? (
        <div className="num-input">
          {param.type === "currency" && <span>$</span>}
          <input
            type="number"
            value={Number(value)}
            min={param.min}
            max={param.max}
            step={param.step ?? 1}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </div>
      ) : param.type === "date" ? (
        <input type="date" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function defaultsOf(ps: RecipeParam[]): ParamValues {
  const v: ParamValues = {};
  for (const p of ps) v[p.name] = p.default;
  return v;
}

function aliasFromFilename(name: string): string {
  let base = name.replace(/\.[^.]+$/, "");
  base = base.replace(
    /[ _-]*(20\d{2}[-_]?\d{2}(?:[-_]?\d{2})?|\d{6,8}|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i,
    "",
  );
  base = base.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return base || "input";
}

function uniqueAlias(base: string, current: InputFile[]): string {
  const taken = new Set(current.map((i) => i.alias));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function downloadBlob(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
