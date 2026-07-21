import { useEffect, useRef, useState } from "react";
import { pyWorker } from "../lib/pyodide";
import { friendlyRunError, prettify } from "../lib/format";
import { ParamControl, defaultsOf, type ParamValues } from "./ParamControl";
import { DataTable } from "./DataTable";
import { PlotView } from "./PlotView";
import type { InputFile, RecipeParam, RunResult, TablePreview } from "../types";

export interface ApplyRecipe {
  name: string;
  description?: string;
  script: string;
  params: RecipeParam[];
  paramValues: ParamValues;
  inputs: { alias: string; columns: string[] }[];
}

interface Slot {
  fileName: string;
  preview: TablePreview;
}

/**
 * Focused "run a recipe" screen: named drop-slots (one per input), knobs, live
 * output, download. Used for shared links (mode="shared") and for opening your
 * own recipe (mode="owner"). The recipe text is all that's shared — every file
 * dropped here is read locally in this browser and never uploaded.
 */
export function ApplyView({
  recipe,
  mode,
  onEdit,
  onSaveCopy,
  onExit,
}: {
  recipe: ApplyRecipe;
  mode: "owner" | "shared";
  onEdit?: (inputs: InputFile[], paramValues: ParamValues) => void;
  onSaveCopy?: (paramValues: ParamValues, inputs: InputFile[]) => Promise<string | null>;
  onExit: () => void;
}) {
  // A recipe should always have at least one slot to drop a file into, even if
  // it recorded no input schema.
  const slotSpecs = recipe.inputs.length ? recipe.inputs : [{ alias: "input", columns: [] as string[] }];
  const slotAliases = slotSpecs.map((i) => i.alias);
  const [slots, setSlots] = useState<Record<string, Slot | null>>(() =>
    Object.fromEntries(slotAliases.map((a) => [a, null])),
  );
  // Which slots are filled — tracked in a ref so independent, concurrent drops
  // don't race on stale state when deciding whether all slots are ready.
  const filledRef = useRef<Set<string>>(new Set());
  const [loadingSlot, setLoadingSlot] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<ParamValues>(() => ({
    ...defaultsOf(recipe.params),
    ...recipe.paramValues,
  }));
  const [output, setOutput] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  // Fresh worker state whenever we enter an apply view.
  useEffect(() => {
    void pyWorker.clearInputs();
    pyWorker.warmUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filled = slotAliases.filter((a) => slots[a]);
  const allFilled = filled.length === slotAliases.length;

  async function run(values: ParamValues) {
    setRunning(true);
    setRunError(null);
    try {
      setOutput(await pyWorker.runScript(recipe.script, values));
    } catch (err) {
      setOutput(null);
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function dropToSlot(alias: string, files: File[]) {
    const file = files.find((f) => !f.name.toLowerCase().endsWith(".py"));
    if (!file) return;
    setSlotError(null);
    setLoadingSlot(alias);
    try {
      const buffer = await file.arrayBuffer();
      const { preview } = await pyWorker.loadInput(alias, file.name, buffer);
      setSlots((prev) => ({ ...prev, [alias]: { fileName: file.name, preview } }));
      filledRef.current.add(alias);
      if (slotAliases.every((a) => filledRef.current.has(a))) void run(paramValues);
    } catch (err) {
      setSlotError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSlot(null);
    }
  }

  async function clearSlot(alias: string) {
    await pyWorker.removeInput(alias);
    filledRef.current.delete(alias);
    setSlots((prev) => ({ ...prev, [alias]: null }));
    setOutput(null);
    setRunError(null);
  }

  function setParam(name: string, value: string | number | boolean) {
    const values = { ...paramValues, [name]: value };
    setParamValues(values);
    if (filledRef.current.size === slotAliases.length) void run(values);
  }

  function loadedInputs(): InputFile[] {
    return slotAliases
      .filter((a) => slots[a])
      .map((a) => ({ alias: a, fileName: slots[a]!.fileName, preview: slots[a]!.preview }));
  }

  async function downloadTable(name: string) {
    if (exporting) return;
    setExporting(name);
    try {
      const { csv } = await pyWorker.exportTable(name);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name.replace(/\s+/g, "_")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  }

  async function saveCopy() {
    if (!onSaveCopy || saving) return;
    setSaving(true);
    try {
      const name = await onSaveCopy(paramValues, loadedInputs());
      setSaveMsg(name ? `Saved “${name}” to your library` : "Saved to your library");
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="apply">
      <div className="apply-head">
        <div>
          <div className="apply-eyebrow">
            {mode === "shared" ? "Shared recipe" : "Run recipe"}
            <span className="apply-privacy">· your files stay in your browser</span>
          </div>
          <h1 className="apply-title">{recipe.name}</h1>
          {recipe.description && <p className="apply-desc">{recipe.description}</p>}
        </div>
        <button className="btn ghost" onClick={onExit}>{mode === "shared" ? "Start fresh" : "Close"}</button>
      </div>

      <h2 className="apply-section-title">
        Drop your files
        <span className="muted"> — one per slot</span>
      </h2>
      <div className="slots-grid">
        {slotSpecs.map((inp) => {
          const s = slots[inp.alias];
          return (
            <div className={`slot ${s ? "filled" : ""}`} key={inp.alias}>
              <div className="slot-head">
                <span className="slot-name">{inp.alias}</span>
                {s && (
                  <button className="slot-clear" title="Remove" aria-label={`Remove ${inp.alias}`} onClick={() => clearSlot(inp.alias)}>×</button>
                )}
              </div>
              {s ? (
                <div className="slot-file">
                  <span className="slot-filename">{s.fileName}</span>
                  <span className="muted">{s.preview.rowCount.toLocaleString()} rows</span>
                </div>
              ) : (
                <SlotDrop
                  alias={inp.alias}
                  columns={inp.columns}
                  loading={loadingSlot === inp.alias}
                  onFiles={(files) => dropToSlot(inp.alias, files)}
                />
              )}
            </div>
          );
        })}
      </div>
      {slotError && <div className="error" style={{ marginTop: 12 }}>{slotError}</div>}

      {recipe.params.length > 0 && (
        <>
          <h2 className="apply-section-title">Settings</h2>
          <div className="card"><div className="card-body">
            <div className="params-grid">
              {recipe.params.map((p) => (
                <ParamControl key={p.name} param={p} value={paramValues[p.name]} onChange={(v) => setParam(p.name, v)} />
              ))}
            </div>
          </div></div>
        </>
      )}

      {running && <div className="status" style={{ marginTop: 16 }}><span className="spinner" aria-hidden="true" />Running…</div>}
      {runError && (
        <div className="run-error" style={{ marginTop: 16 }}>
          <div className="run-error-title">This recipe couldn't run on your files.</div>
          <p style={{ margin: "0 0 8px" }}>{friendlyRunError(runError)}</p>
          <details><summary>Technical details</summary><pre>{runError}</pre></details>
        </div>
      )}

      {!allFilled && !running && (
        <p className="apply-hint">Drop a file into {slotAliases.length === 1 ? "the slot" : `all ${slotAliases.length} slots`} above to run the recipe.</p>
      )}

      {output && (
        <section className="output section" style={{ marginTop: 20 }}>
          {output.tables.map((t) => (
            <div className="card" key={t.name}>
              <div className="card-header">
                <h2>{prettify(t.name)}</h2>
                <span className="count">{t.preview.rowCount.toLocaleString()} rows · {t.preview.columns.length} cols</span>
                <button className="btn ghost" disabled={exporting === t.name} onClick={() => downloadTable(t.name)}>
                  {exporting === t.name ? <><span className="spinner" aria-hidden="true" />Preparing…</> : "Download CSV"}
                </button>
              </div>
              <DataTable preview={t.preview} />
            </div>
          ))}
          {output.plots.map((p) => (
            <PlotView key={p.name} spec={p} />
          ))}
        </section>
      )}

      <div className="apply-actions">
        {mode === "shared" && onSaveCopy && (
          <button className="btn primary" disabled={saving} onClick={saveCopy}>
            {saving ? <><span className="spinner" aria-hidden="true" />Saving…</> : "Save a copy to my library"}
          </button>
        )}
        {mode === "owner" && onEdit && (
          <button className="btn" onClick={() => onEdit(loadedInputs(), paramValues)}>Edit recipe</button>
        )}
        {saveMsg && <span className="saved-msg">{saveMsg}</span>}
      </div>
    </section>
  );
}

function SlotDrop({
  alias,
  columns,
  loading,
  onFiles,
}: {
  alias: string;
  columns: string[];
  loading: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hint = columns.length ? columns.slice(0, 4).join(", ") + (columns.length > 4 ? "…" : "") : "CSV or Excel";
  return (
    <div
      className={`slot-drop ${over ? "over" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
    >
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {loading ? (
        <span className="slot-drop-main"><span className="spinner" aria-hidden="true" /> Reading…</span>
      ) : (
        <>
          <span className="slot-drop-main">Drop your <b>{alias}</b> file</span>
          <span className="slot-drop-hint">expects: {hint}</span>
        </>
      )}
    </div>
  );
}
