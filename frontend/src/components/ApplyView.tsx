import { useEffect, useRef, useState } from "react";
import { dataWorker } from "../lib/worker";
import { friendlyRunError, prettify } from "../lib/format";
import { ParamControl, defaultsOf, useParamOptions, type ParamValues } from "./ParamControl";
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
  /** Built-in example files (templates only) — enables one-click "Try with example". */
  samples?: { alias: string; filename: string; csv: string }[];
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
  canSave = true,
  onRequestSignIn,
  onExit,
}: {
  recipe: ApplyRecipe;
  mode: "owner" | "shared" | "template";
  onEdit?: (inputs: InputFile[], paramValues: ParamValues) => void;
  onSaveCopy?: (paramValues: ParamValues, inputs: InputFile[]) => Promise<string | null>;
  /** False when saving requires signing in first (labels the button honestly). */
  canSave?: boolean;
  /** Opens the sign-in modal; the save resumes here once `canSave` turns true. */
  onRequestSignIn?: () => void;
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
  const paramRunTimer = useRef<number | undefined>(undefined);
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
  // A save the user asked for while signed out, waiting on the sign-in modal.
  const [pendingCopy, setPendingCopy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  // Fresh worker state whenever we enter an apply view.
  useEffect(() => {
    void dataWorker.clearInputs();
    dataWorker.warmUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filled = slotAliases.filter((a) => slots[a]);
  const allFilled = filled.length === slotAliases.length;
  const paramOptions = useParamOptions(
    recipe.params,
    filled.map((a) => ({ alias: a, columns: slots[a]!.preview.columns })),
  );

  async function run(values: ParamValues) {
    setRunning(true);
    setRunError(null);
    try {
      setOutput(await dataWorker.runScript(recipe.script, values));
    } catch (err) {
      setOutput(null);
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function dropToSlot(alias: string, files: File[]) {
    const file = files.find((f) => !f.name.toLowerCase().endsWith(".js"));
    if (!file) return;
    setSlotError(null);
    setLoadingSlot(alias);
    try {
      const buffer = await file.arrayBuffer();
      const { preview } = await dataWorker.loadInput(alias, file.name, buffer);
      setSlots((prev) => ({ ...prev, [alias]: { fileName: file.name, preview } }));
      filledRef.current.add(alias);
      if (slotAliases.every((a) => filledRef.current.has(a))) void run(paramValues);
    } catch (err) {
      setSlotError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSlot(null);
    }
  }

  async function loadSampleData() {
    if (!recipe.samples || loadingSlot) return;
    setSlotError(null);
    try {
      for (const s of recipe.samples) {
        setLoadingSlot(s.alias);
        const buffer = new TextEncoder().encode(s.csv).buffer as ArrayBuffer;
        const { preview } = await dataWorker.loadInput(s.alias, s.filename, buffer);
        setSlots((prev) => ({ ...prev, [s.alias]: { fileName: s.filename, preview } }));
        filledRef.current.add(s.alias);
      }
      setLoadingSlot(null);
      if (slotAliases.every((a) => filledRef.current.has(a))) void run(paramValues);
    } catch (err) {
      setLoadingSlot(null);
      setSlotError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearSlot(alias: string) {
    await dataWorker.removeInput(alias);
    filledRef.current.delete(alias);
    setSlots((prev) => ({ ...prev, [alias]: null }));
    setOutput(null);
    setRunError(null);
  }

  function setParam(name: string, value: string | number | boolean) {
    const values = { ...paramValues, [name]: value };
    setParamValues(values);
    // Debounced so typing a combobox value doesn't run on every keystroke.
    if (filledRef.current.size === slotAliases.length) {
      if (paramRunTimer.current) clearTimeout(paramRunTimer.current);
      paramRunTimer.current = window.setTimeout(() => void run(values), 400);
    }
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
      const { csv } = await dataWorker.exportTable(name);
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

  // Finish a save that was waiting on sign-in, as soon as we're signed in.
  useEffect(() => {
    if (pendingCopy && canSave) {
      setPendingCopy(false);
      void saveCopy();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCopy, canSave]);

  async function saveCopy() {
    if (!onSaveCopy || saving) return;
    if (!canSave) {
      // Resumed by the effect below once sign-in completes. Gating here (rather
      // than inside the parent's save handler) keeps it reacting to the CURRENT
      // auth state — a deferred call captured in the parent would re-check the
      // stale `user` from before sign-in and bounce the user back to the modal.
      setPendingCopy(true);
      setSaveMsg(null);
      onRequestSignIn?.();
      return;
    }
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
            {mode === "shared" ? "Shared recipe" : mode === "template" ? "Template" : "Run recipe"}
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
        {recipe.samples && filled.length === 0 && (
          <button className="btn primary try-example" disabled={!!loadingSlot} onClick={loadSampleData}>
            {loadingSlot ? <><span className="spinner" aria-hidden="true" />Loading…</> : "▶ Try with example data"}
          </button>
        )}
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
                <ParamControl key={p.name} param={p} value={paramValues[p.name]} options={paramOptions[p.name]} onChange={(v) => setParam(p.name, v)} />
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
        {(mode === "shared" || mode === "template") && onSaveCopy && (
          <button className="btn primary" disabled={saving} onClick={saveCopy}>
            {saving
              ? <><span className="spinner" aria-hidden="true" />Saving…</>
              : !canSave ? "Sign up to save it"
              : mode === "template" ? "Save to my library" : "Save a copy to my library"}
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
