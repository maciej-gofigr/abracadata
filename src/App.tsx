import { useEffect, useState } from "react";
import { APP_NAME } from "./branding";
import { DataTable } from "./components/DataTable";
import { DropZone } from "./components/DropZone";
import { PlotView } from "./components/PlotView";
import { pyWorker } from "./lib/pyodide";
import { buildRecipe, parseRecipe } from "./lib/recipe";
import { prettify } from "./lib/format";
import {
  SAMPLE_CUSTOMERS_CSV,
  SAMPLE_ORDERS_CSV,
  SAMPLE_PARAMS,
  SAMPLE_SCRIPT,
} from "./lib/fixtures";
import {
  addVersion,
  createRecipe,
  explanationOnly,
  generateRecipe,
  getRecipe,
  listRecipes,
  listVersions,
  type RecipeSummary,
  type VersionSummary,
} from "./lib/api";
import type { ChatMessage, InputFile, RecipeMeta, RecipeParam, RunResult } from "./types";

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

  const [describeText, setDescribeText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [assistantText, setAssistantText] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [library, setLibrary] = useState<RecipeSummary[]>([]);
  const [currentRecipeId, setCurrentRecipeId] = useState<string | null>(null);
  const [currentRecipeName, setCurrentRecipeName] = useState("");
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [libMsg, setLibMsg] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
  const [expectedInputs, setExpectedInputs] = useState<{ alias: string; columns: string[] }[]>([]);

  useEffect(() => {
    pyWorker.warmUp();
    void refreshLibrary();
  }, []);

  async function refreshLibrary() {
    try {
      setLibrary(await listRecipes());
    } catch {
      /* backend may be down in dev */
    }
  }

  async function run(src: string, values: ParamValues, ins: InputFile[]) {
    if (!src || ins.length === 0) return;
    setRunning(true);
    setRunError(null);
    try {
      setOutput(await pyWorker.runScript(src, values));
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
    if (script && current.length && !loadedRecipe) void run(script, paramValues, current);
  }

  async function loadDataFile(file: File, current: InputFile[]): Promise<InputFile | null> {
    setLoadingMsg(`Reading ${file.name}… (first load also fetches the runtime, ~10s)`);
    try {
      let alias = uniqueAlias(aliasFromFilename(file.name), current);
      const buffer = await file.arrayBuffer();
      const { preview } = await pyWorker.loadInput(alias, file.name, buffer);
      // Re-running a saved recipe: snap this file into the named slot whose
      // columns it matches, so it works regardless of this month's filename.
      if (expectedInputs.length) {
        const taken = new Set(current.map((i) => i.alias));
        const match = matchExpectedSlot(preview.columns, expectedInputs, taken);
        if (match && match !== alias) {
          await pyWorker.renameInput(alias, match);
          alias = match;
        }
      }
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
    setLoadingMsg("Loading sample files… (first load also fetches the runtime, ~10s)");
    try {
      await pyWorker.clearInputs();
      const enc = new TextEncoder();
      const ord = await pyWorker.loadInput("orders", "orders.csv", enc.encode(SAMPLE_ORDERS_CSV).buffer as ArrayBuffer);
      const cus = await pyWorker.loadInput("customers", "customers.csv", enc.encode(SAMPLE_CUSTOMERS_CSV).buffer as ArrayBuffer);
      const next: InputFile[] = [
        { alias: "orders", fileName: "orders.csv", preview: ord.preview },
        { alias: "customers", fileName: "customers.csv", preview: cus.preview },
      ];
      setInputs(next);
      setScript(SAMPLE_SCRIPT);
      setParams(SAMPLE_PARAMS);
      const values = defaultsOf(SAMPLE_PARAMS);
      setParamValues(values);
      setMessages([]);
      setAssistantText("");
      setCurrentRecipeId(null);
      setCurrentRecipeName("Revenue by region");
      await run(SAMPLE_SCRIPT, values, next);
    } catch (err) {
      setFileError(errorMessage(err));
    } finally {
      setLoadingMsg(null);
    }
  }

  async function generate() {
    const q = describeText.trim();
    if (!q || generating || inputs.length === 0) return;
    const history: ChatMessage[] = [...messages, { role: "user", text: q }];
    setMessages(history);
    setDescribeText("");
    setGenerating(true);
    setAssistantText("");
    setGenError(null);
    let acc = "";
    await generateRecipe(
      {
        inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns, dtypes: i.preview.dtypes })),
        params: paramValues,
        messages: history.map((m) => ({ role: m.role, text: m.text })),
      },
      (delta) => {
        acc += delta;
        setAssistantText(acc);
      },
      (generated) => {
        setMessages([...history, { role: "assistant", text: acc }]);
        setGenerating(false);
        if (generated) {
          setScript(generated);
          // AI recipes don't declare tunable params yet — clear the panel so it
          // never shows stale controls that don't match the current recipe.
          setParams([]);
          setParamValues({});
          void run(generated, {}, inputs);
        } else {
          setGenError("The model didn't return a recipe — try rephrasing.");
        }
      },
      (msg) => {
        setGenerating(false);
        setGenError(msg);
      },
    );
  }

  function setParam(name: string, value: string | number | boolean) {
    const values = { ...paramValues, [name]: value };
    setParamValues(values);
    if (script) void run(script, values, inputs);
  }

  async function commitAlias(inp: InputFile) {
    const raw = aliasDraft[inp.fileName];
    setAliasDraft((d) => {
      const next = { ...d };
      delete next[inp.fileName];
      return next;
    });
    const next = (raw ?? "").trim();
    if (!next || next === inp.alias) return;
    if (inputs.some((i) => i !== inp && i.alias === next)) {
      setFileError(`Another slot is already named “${next}”.`);
      return;
    }
    await pyWorker.renameInput(inp.alias, next);
    const updated = inputs.map((i) => (i === inp ? { ...i, alias: next } : i));
    setInputs(updated);
    if (script) void run(script, paramValues, updated);
  }

  async function saveToLibrary() {
    if (!script) return;
    const payload = {
      script,
      params,
      inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      prompt: messages.filter((m) => m.role === "user").slice(-1)[0]?.text,
    };
    try {
      if (currentRecipeId) {
        const d = await addVersion(currentRecipeId, payload);
        setLibMsg(`Saved v${d.current_version?.version_no}`);
        await refreshVersions(currentRecipeId);
      } else {
        const name = currentRecipeName || messages.find((m) => m.role === "user")?.text?.slice(0, 48) || "Untitled recipe";
        const d = await createRecipe({ name, ...payload });
        setCurrentRecipeId(d.id);
        setCurrentRecipeName(d.name);
        setLibMsg(`Saved “${d.name}”`);
      }
      await refreshLibrary();
    } catch (err) {
      setLibMsg(`Save failed: ${errorMessage(err)}`);
    }
  }

  async function refreshVersions(id: string) {
    try {
      setVersions(await listVersions(id));
    } catch {
      setVersions([]);
    }
  }

  async function openRecipe(id: string) {
    try {
      const d = await getRecipe(id);
      const cv = d.current_version;
      if (!cv) return;
      setScript(cv.script);
      const ps = (Array.isArray(cv.params) ? cv.params : []) as RecipeParam[];
      setParams(ps);
      const values = defaultsOf(ps);
      setParamValues(values);
      setCurrentRecipeId(d.id);
      setCurrentRecipeName(d.name);
      setExpectedInputs(Array.isArray(cv.inputs) ? (cv.inputs as { alias: string; columns: string[] }[]) : []);
      await refreshVersions(d.id);
      if (inputs.length) {
        setLibMsg(`Opened “${d.name}” (v${cv.version_no})`);
        void run(cv.script, values, inputs);
      } else {
        setLibMsg(`Opened “${d.name}” — drop this month's files to run it`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (err) {
      setLibMsg(`Open failed: ${errorMessage(err)}`);
    }
  }

  function reset() {
    setInputs([]);
    setScript(null);
    setParams([]);
    setParamValues({});
    setOutput(null);
    setRunError(null);
    setFileError(null);
    setMessages([]);
    setAssistantText("");
    setGenError(null);
    setCurrentRecipeId(null);
    setCurrentRecipeName("");
    setVersions([]);
    setShowCode(false);
    setExpectedInputs([]);
    setLibMsg(null);
    void pyWorker.clearInputs();
  }

  async function downloadTable(name: string) {
    const { csv } = await pyWorker.exportTable(name);
    downloadBlob(`${name.replace(/\s+/g, "_")}.csv`, csv, "text/csv");
  }

  function downloadRecipeFile() {
    if (!script) return;
    const meta: RecipeMeta = {
      version: 2,
      name: currentRecipeName || "recipe",
      created: new Date().toISOString(),
      prompts: messages.filter((m) => m.role === "user").map((m) => m.text),
      inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      params,
    };
    downloadBlob(`${(meta.name || "recipe").replace(/\s+/g, "_")}.py`, buildRecipe(script, meta), "text/x-python");
  }

  const hasInputs = inputs.length > 0;
  const explanation = explanationOnly(assistantText);

  const library_panel =
    library.length > 0 ? (
      <section className="card section library">
        <div className="card-header">
          <h2>Your recipes</h2>
          <span className="count">saved &amp; versioned on the server — recipes only, never your data</span>
        </div>
        <div className="card-body">
          <p className="reuse-hint">Next month, open one and drop your new files — it re-runs the same steps.</p>
          <ul className="recipe-list">
            {library.map((r) => (
              <li key={r.id} className={r.id === currentRecipeId ? "active" : ""}>
                <div className="recipe-row">
                  <span className="recipe-name">{r.name}</span>
                  <span className="muted">v{r.version_count} · {relTime(r.updated_at)}</span>
                  <button className="btn ghost" onClick={() => openRecipe(r.id)}>Open</button>
                </div>
                {r.id === currentRecipeId && versions.length > 0 && (
                  <ul className="version-list">
                    {versions.map((v) => (
                      <li key={v.id}>
                        <span className="vno">v{v.version_no}</span>
                        <span className="muted">{relTime(v.created_at)}</span>
                        {v.prompt && <span className="vprompt">“{v.prompt}”</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    ) : null;

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="5" fill="var(--accent-tint)" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M7 8.5h6M7 12h10M7 15.5h7" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="17.5" cy="8.5" r="1.4" fill="var(--accent)" />
          </svg>
          <span>{APP_NAME}</span>
        </div>
        <div className="spacer" />
        <span className="chip">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 11V8a6 6 0 1112 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><rect x="4" y="11" width="16" height="9" rx="2" fill="currentColor" opacity=".18" /><rect x="4" y="11" width="16" height="9" rx="2" stroke="currentColor" strokeWidth="2" /></svg>
          Runs in your browser
        </span>
        <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle light and dark theme" title="Toggle theme">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
        </button>
        {hasInputs && (
          <button className="btn ghost" onClick={reset}>Start over</button>
        )}
      </div>

      <main>
        {!hasInputs && (
          <section className="landing">
            <div className="eyebrow">For the spreadsheet you rebuild every month</div>
            <h1>Describe it once. <em>Re-run it forever.</em></h1>
            <p className="lede">
              Drop your CSV or Excel files and say what you need in plain English — join them, clean them,
              summarize, chart. You get a reusable recipe that does the exact same thing to next month's files.
            </p>

            {currentRecipeName && (
              <div className="reopen-banner">
                <strong>Ready to re-run “{currentRecipeName}”.</strong>{" "}
                Drop this month's files below
                {expectedInputs.length > 0 && (
                  <> — it expects {expectedInputs.map((e, i) => (
                    <span key={e.alias}>{i > 0 ? ", " : ""}<code>{e.alias}</code></span>
                  ))}</>
                )}.
              </div>
            )}

            <DropZone
              onFiles={handleFiles}
              label={currentRecipeName ? `Drop this month's files for “${currentRecipeName}”` : "Drop one or more CSV / Excel files"}
              hint="Everything runs in your browser — your data never leaves this machine."
            />

            <div className="or">or try it with sample data</div>
            <div className="samples">
              <button className="sample-btn" onClick={loadSample}>
                <span className="dot" /> Sample: orders + customers
              </button>
            </div>

            <div className="how">
              <div className="how-step"><span className="how-num">1</span><div><div className="how-t">Drop</div><div className="how-d">One or more files, read locally in seconds.</div></div></div>
              <div className="how-step"><span className="how-num">2</span><div><div className="how-t">Describe</div><div className="how-d">Say what you need — join, clean, summarize, chart.</div></div></div>
              <div className="how-step"><span className="how-num">3</span><div><div className="how-t">Reuse</div><div className="how-d">Save the recipe, re-run it next month.</div></div></div>
            </div>

            {loadingMsg && <div className="status" style={{ marginTop: 24 }}>{loadingMsg}</div>}
            {fileError && <div className="error" style={{ marginTop: 20 }}>{fileError}</div>}

            {library_panel && <div style={{ marginTop: 40 }}>{library_panel}</div>}
          </section>
        )}

        {hasInputs && (
          <>
            <div className="header-row">
              <h2 className="page-title">{currentRecipeName || "Untitled recipe"}</h2>
            </div>

            {loadingMsg && <div className="status">{loadingMsg}</div>}
            {fileError && <div className="error">{fileError}</div>}

            <section className="section">
              <div className="header-row" style={{ marginBottom: 12 }}>
                <h2 className="page-title" style={{ fontSize: 15 }}>
                  Your files <span className="muted">— rename a slot to reuse this recipe on next month's files</span>
                </h2>
              </div>
              <div className="inputs-grid">
                {inputs.map((inp) => (
                  <div className="card" key={inp.fileName + inp.alias}>
                    <div className="card-header">
                      <input
                        className="alias-input"
                        value={aliasDraft[inp.fileName] ?? inp.alias}
                        aria-label="Slot name"
                        onChange={(e) => setAliasDraft({ ...aliasDraft, [inp.fileName]: e.target.value })}
                        onBlur={() => commitAlias(inp)}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      />
                      <span className="from-file">{inp.fileName}</span>
                    </div>
                    <DataTable preview={inp.preview} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <DropZone onFiles={handleFiles} compact label="+ Add another file" />
              </div>
            </section>

            <section className="card section describe">
              <div className="card-header">
                <h2>Describe what you need</h2>
                <span className="count">plain English — the AI writes the recipe</span>
              </div>
              <div className="card-body">
                {(explanation || generating) && (
                  <div className="assistant-reply">
                    {explanation || "Thinking…"}
                    {generating && <span className="cursor">▍</span>}
                  </div>
                )}
                {genError && <div className="run-error" style={{ marginBottom: 12 }}><pre>{genError}</pre></div>}
                <div className="describe-input">
                  <textarea
                    value={describeText}
                    placeholder={'e.g. "join orders to customers, then total revenue by region as a bar chart"'}
                    rows={2}
                    onChange={(e) => setDescribeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void generate();
                      }
                    }}
                  />
                  <button className="btn primary" disabled={generating || !describeText.trim()} onClick={() => void generate()}>
                    {generating ? "Generating…" : "Generate"}
                  </button>
                </div>
              </div>
            </section>

            {params.length > 0 && (
              <section className="card section">
                <div className="card-header">
                  <h2>Adjustable settings</h2>
                  <span className="count">edits re-run instantly, in your browser</span>
                </div>
                <div className="card-body">
                  <div className="params-grid">
                    {params.map((p) => (
                      <ParamControl key={p.name} param={p} value={paramValues[p.name]} onChange={(v) => setParam(p.name, v)} />
                    ))}
                  </div>
                </div>
              </section>
            )}

            {running && <div className="status">Running…</div>}
            {runError && (
              <div className="run-error">
                <div className="run-error-title">This recipe couldn't run on your files.</div>
                <p style={{ margin: "0 0 8px" }}>{friendlyRunError(runError)}</p>
                <details>
                  <summary>Technical details</summary>
                  <pre>{runError}</pre>
                </details>
              </div>
            )}

            {output && (
              <section className="output section">
                {output.tables.map((t) => (
                  <div className="card" key={t.name}>
                    <div className="card-header">
                      <h2>{prettify(t.name)}</h2>
                      <span className="count">{t.preview.rowCount.toLocaleString()} rows · {t.preview.columns.length} cols</span>
                      <button className="btn ghost" onClick={() => downloadTable(t.name)}>Download CSV</button>
                    </div>
                    <DataTable preview={t.preview} />
                  </div>
                ))}
                {output.plots.map((p) => (
                  <PlotView key={p.name} spec={p} />
                ))}
              </section>
            )}

            {script && (
              <>
                <div className="save-bar">
                  <button className="btn primary" onClick={saveToLibrary}>
                    {currentRecipeId ? "Save new version" : "Save to library"}
                  </button>
                  {libMsg && <span className="saved-msg">{libMsg}</span>}
                </div>

                <div className="card section disclosure">
                  <div className="disclosure-head">
                    <button className={`disclose-btn ${showCode ? "open" : ""}`} onClick={() => setShowCode(!showCode)} aria-expanded={showCode}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      {showCode ? "Hide the steps (Python)" : "Show the steps (Python)"}
                    </button>
                    <div className="spacer" />
                    <button className="btn ghost" onClick={downloadRecipeFile}>Download recipe (.py)</button>
                  </div>
                  {showCode && (
                    <div className="code">
                      <textarea value={script} spellCheck={false} onChange={(e) => setScript(e.target.value)} />
                    </div>
                  )}
                </div>
              </>
            )}

            {library_panel}
          </>
        )}
      </main>
    </>
  );
}

function toggleTheme() {
  const root = document.documentElement;
  const explicit = root.getAttribute("data-theme");
  const isDark = explicit ? explicit === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", isDark ? "light" : "dark");
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
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : param.type === "bool" ? (
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
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

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

function aliasFromFilename(name: string): string {
  let base = name.replace(/\.[^.]+$/, "");
  // Strip a trailing date/period suffix (orders_august, orders_2026-06, orders_q3).
  base = base.replace(
    new RegExp(`[ _-]*(20\\d{2}[-_]?\\d{2}(?:[-_]?\\d{2})?|\\d{6,8}|q[1-4]|${MONTHS})([ _-]?20\\d{2})?$`, "i"),
    "",
  );
  base = base.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return base || "input";
}

/** Best expected slot for a file's columns (>=60% of the slot's columns present). */
function matchExpectedSlot(
  columns: string[],
  expected: { alias: string; columns: string[] }[],
  taken: Set<string>,
): string | null {
  const have = new Set(columns.map((c) => c.toLowerCase()));
  let best: string | null = null;
  let bestScore = 0;
  for (const e of expected) {
    if (taken.has(e.alias) || !e.columns?.length) continue;
    const want = e.columns.map((c) => c.toLowerCase());
    const shared = want.filter((c) => have.has(c)).length;
    const score = shared / want.length;
    if (score > bestScore) {
      bestScore = score;
      best = e.alias;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

function uniqueAlias(base: string, current: InputFile[]): string {
  const taken = new Set(current.map((i) => i.alias));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Translate a Python traceback's last line into something a non-technical
 * user can act on. Falls back to the raw last line if we don't recognise it. */
function friendlyRunError(trace: string): string {
  const last = trace.trim().split("\n").filter(Boolean).pop() ?? trace;
  let m: RegExpMatchArray | null;
  if ((m = last.match(/KeyError:\s*['"]?([^'"]+)/))) {
    return `The recipe looked for “${m[1]}” but couldn't find it — a column may be named differently in this month's file, or a file was dropped into the wrong slot.`;
  }
  if (last.includes("No input files loaded")) return "Drop your files first, then the recipe will run.";
  if ((m = last.match(/No output table named ['"]?([^'"]+)/))) return `The recipe didn't produce a “${m[1]}” table.`;
  if (last.includes("produced no output tables")) return "The recipe finished but produced no table to show.";
  if (last.match(/(ValueError|TypeError|AttributeError|MergeError):/)) {
    return `${last.replace(/^\w+Error:\s*/, "")} — this usually means the data looks different from what the recipe expects.`;
  }
  return last;
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
