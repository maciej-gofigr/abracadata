import { useEffect, useRef, useState } from "react";
import { APP_NAME, APP_TAGLINE } from "./branding";
import { AuthModal } from "./components/AuthModal";
import { DataTable } from "./components/DataTable";
import { DropZone } from "./components/DropZone";
import { PlotView } from "./components/PlotView";
import { dataWorker } from "./lib/worker";
import { buildRecipe, parseRecipe } from "./lib/recipe";
import { friendlyRunError, paramSettings, prettify } from "./lib/format";
import {
  SAMPLE_CUSTOMERS_CSV,
  SAMPLE_ORDERS_CSV,
  SAMPLE_SUGGESTIONS,
} from "./lib/fixtures";
import {
  addVersion,
  authLogout,
  authMe,
  createRecipe,
  deleteRecipe,
  explanationOnly,
  getRecipe,
  getSharedRecipe,
  listRecipes,
  listVersions,
  renameRecipe,
  shareRecipe,
  suggestPrompts,
  unshareRecipe,
  type RecipeDetail,
  type RecipeSummary,
  type SharedRecipe,
  type VersionSummary,
} from "./lib/api";
import { runAgent, type AgentActivity, type AgentTurn } from "./lib/agent";
import { chatEntries } from "./lib/chat";
import { ParamControl, defaultsOf, useParamOptions, type ParamValues } from "./components/ParamControl";
import { ApplyView, type ApplyRecipe } from "./components/ApplyView";
import { GalleryPage, GALLERY_DESC } from "./components/GalleryPage";
import { RecipePanel } from "./components/RecipePanel";
import { TEMPLATES, templateBySlug, type Template } from "./lib/templates";
import type { InputFile, RecipeMeta, RecipeParam, RecipeStep, RunResult } from "./types";

// Passwordless sign-in needs an email sender (SES). Until that's wired, the prod
// build sets VITE_AUTH_ENABLED=false so the app is cleanly anonymous-only.
const AUTH_ENABLED = import.meta.env.VITE_AUTH_ENABLED !== "false";

export function App() {
  const [inputs, setInputs] = useState<InputFile[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [params, setParams] = useState<RecipeParam[]>([]);
  const [steps, setSteps] = useState<RecipeStep[]>([]);
  const chatLogRef = useRef<HTMLDivElement>(null);
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
  const [transcript, setTranscript] = useState<AgentTurn[]>([]);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<{ question: string; askId: string | null } | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [allowDataAccess, setAllowDataAccess] = useState(() => localStorage.getItem("allowDataAccess.v1") !== "0");
  const agentAbort = useRef<AbortController | null>(null);
  const paramRunTimer = useRef<number | undefined>(undefined);

  const [library, setLibrary] = useState<RecipeSummary[]>([]);
  const [currentRecipeId, setCurrentRecipeId] = useState<string | null>(null);
  const [currentRecipeName, setCurrentRecipeName] = useState("");
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [libMsg, setLibMsg] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
  const [activeInputIdx, setActiveInputIdx] = useState(0);
  const [expectedInputs, setExpectedInputs] = useState<{ alias: string; columns: string[] }[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [exportingTable, setExportingTable] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [user, setUser] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  const [applyState, setApplyState] = useState<{ recipe: ApplyRecipe; mode: "owner" | "shared" | "template"; recipeId?: string } | null>(null);
  const [showGallery, setShowGallery] = useState(false);
  const [sharePanelId, setSharePanelId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [copiedShare, setCopiedShare] = useState(false);

  useEffect(() => {
    dataWorker.warmUp();
    void refreshLibrary();
    if (AUTH_ENABLED) void authMe().then((r) => setUser(r.email)).catch(() => {});
    applyRoute(window.location.pathname);
    const onPop = () => applyRoute(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest chat message in view as the conversation grows / streams.
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, assistantText, activities, generating]);

  // Set view state from the current URL path (deep links, back/forward).
  function applyRoute(path: string) {
    const shared = path.match(/^\/s\/([^/]+)/);
    const tpl = path.match(/^\/t\/([^/]+)/);
    if (shared) {
      setShowGallery(false);
      void getSharedRecipe(decodeURIComponent(shared[1]))
        .then((s) => {
          setApplyState({ recipe: applyRecipeFromShared(s), mode: "shared" });
          setMeta(`${s.name} — ${APP_NAME}`, "A shared Abracadata recipe — drop your files and run it.");
        })
        .catch((err) => setFileError(err instanceof Error ? err.message : String(err)));
    } else if (tpl) {
      const t = templateBySlug(decodeURIComponent(tpl[1]));
      setShowGallery(false);
      if (t) {
        setApplyState({ recipe: templateToApply(t), mode: "template" });
        setMeta(`${t.name} — ${APP_NAME}`, t.description);
      } else {
        setApplyState(null);
      }
    } else if (path === "/templates") {
      setApplyState(null);
      setShowGallery(true);
      setMeta(`Templates — ${APP_NAME}`, GALLERY_DESC);
    } else {
      setApplyState(null);
      setShowGallery(false);
      setMeta(APP_NAME, APP_TAGLINE);
    }
  }

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
      setOutput(await dataWorker.runScript(src, values));
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
    let addedData = false;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".js")) {
        loadedRecipe = (await loadRecipeFile(file)) || loadedRecipe;
      } else {
        const added = await loadDataFile(file, current);
        if (added) {
          current = [...current.filter((i) => i.alias !== added.alias), added];
          addedData = true;
        }
      }
    }
    setInputs(current);
    if (addedData) setActiveInputIdx(current.length - 1); // focus the file just added
    if (script && current.length && !loadedRecipe) void run(script, paramValues, current);
    // Fresh authoring (no recipe yet): suggest a few things to try, one click each.
    if (addedData && !loadedRecipe && !script && transcript.length === 0) void loadSuggestions(current);
  }

  async function loadSuggestions(ins: InputFile[]) {
    if (!ins.length) return;
    setLoadingSuggestions(true);
    setSuggestions([]);
    try {
      const payload = ins.map((i) => ({
        alias: i.alias,
        columns: i.preview.columns,
        dtypes: i.preview.dtypes,
        // Only send actual values when the user allows data access (same toggle
        // that gates the agent) — grounds suggestions in real categories/regions.
        ...(allowDataAccess ? { sample_rows: i.preview.rows.slice(0, 4) } : {}),
      }));
      setSuggestions(await suggestPrompts(payload));
    } finally {
      setLoadingSuggestions(false);
    }
  }

  async function runSuggestion(s: string) {
    if (generating) return;
    setDescribeText("");
    setSuggestions([]);
    await driveAgent([...transcript, { role: "user", text: s }]);
  }

  async function loadDataFile(file: File, current: InputFile[]): Promise<InputFile | null> {
    setLoadingMsg(`Reading ${file.name}… (first load also fetches the runtime, ~10s)`);
    try {
      let alias = uniqueAlias(aliasFromFilename(file.name), current);
      const buffer = await file.arrayBuffer();
      const { preview } = await dataWorker.loadInput(alias, file.name, buffer);
      // Re-running a saved recipe: snap this file into the named slot whose
      // columns it matches, so it works regardless of this month's filename.
      if (expectedInputs.length) {
        const taken = new Set(current.map((i) => i.alias));
        const match = matchExpectedSlot(preview.columns, expectedInputs, taken);
        if (match && match !== alias) {
          await dataWorker.renameInput(alias, match);
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
    setSteps(parsed.meta?.steps ?? []);
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
      await dataWorker.clearInputs();
      const enc = new TextEncoder();
      const ord = await dataWorker.loadInput("orders", "orders.csv", enc.encode(SAMPLE_ORDERS_CSV).buffer as ArrayBuffer);
      const cus = await dataWorker.loadInput("customers", "customers.csv", enc.encode(SAMPLE_CUSTOMERS_CSV).buffer as ArrayBuffer);
      const next: InputFile[] = [
        { alias: "orders", fileName: "orders.csv", preview: ord.preview },
        { alias: "customers", fileName: "customers.csv", preview: cus.preview },
      ];
      setInputs(next);
      setActiveInputIdx(0);
      // Behave like a file drop: data in, no recipe yet, starter prompts shown.
      // The sample is static, so its suggestions are hardcoded (no Haiku call).
      setScript(null);
      setParams([]);
      setSteps([]);
      setParamValues({});
      resetConversation();
      setCurrentRecipeId(null);
      setCurrentRecipeName("");
      setSuggestions(SAMPLE_SUGGESTIONS);
      setLoadingSuggestions(false);
    } catch (err) {
      setFileError(errorMessage(err));
    } finally {
      setLoadingMsg(null);
    }
  }

  function inputSchemas() {
    return inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns, dtypes: i.preview.dtypes }));
  }

  function userPrompts(): string[] {
    return transcript
      .filter((m) => m.role === "user" && typeof m.text === "string" && m.text)
      .map((m) => m.text as string);
  }

  // Run the agent loop over the given transcript (mutated in place across turns).
  async function driveAgent(t: AgentTurn[]) {
    // Fresh ref so a just-appended user turn renders immediately (answerQuestion
    // mutates the existing array). The loop keeps mutating `t`; we re-publish at
    // the end. `t` and the state array stay value-equal throughout.
    setTranscript([...t]);
    setGenerating(true);
    setAssistantText("");
    setActivities([]);
    setGenError(null);
    setPendingQuestion(null);
    let narration = "";
    const abort = new AbortController();
    agentAbort.current = abort;
    await runAgent(
      inputSchemas(),
      t,
      { allowDataAccess, signal: abort.signal },
      {
        onText: (delta) => {
          narration += delta;
          setAssistantText(explanationOnly(narration));
        },
        onActivity: (a) => setActivities(a),
        onQuestion: (question, askId) => {
          setPendingQuestion({ question, askId });
          setAnswerText("");
          setGenerating(false);
        },
        onFinal: ({ script: src, params: ps, steps: st }) => {
          // The explanation isn't set here — agent.ts records it as an assistant
          // turn, so it renders as a chat bubble like every other reply.
          setGenerating(false);
          setActivities([]);
          setScript(src);
          setParams(ps);
          setSteps(st);
          const values = defaultsOf(ps);
          setParamValues(values);
          void run(src, values, inputs);
        },
        onError: (msg) => {
          setGenerating(false);
          setGenError(msg);
        },
      },
    );
    // The loop mutates `t` in place (no re-render); publish the finished turns so
    // the chat log shows the full history, and drop the live streaming bubble.
    setTranscript([...t]);
    setAssistantText("");
  }

  async function generate() {
    const q = describeText.trim();
    if (!q || generating || inputs.length === 0) return;
    setDescribeText("");
    await driveAgent([...transcript, { role: "user", text: q }]);
  }

  async function answerQuestion() {
    const a = answerText.trim();
    if (!a || !pendingQuestion) return;
    const t = transcript;
    if (pendingQuestion.askId) {
      t.push({ role: "tool", results: [{ id: pendingQuestion.askId, ok: true, content: { answer: a } }] });
    } else {
      t.push({ role: "user", text: a });
    }
    await driveAgent(t);
  }

  function cancelGenerate() {
    // Reset the chat context: a mid-flight transcript can end on an unresolved
    // tool call, which would break the next generation. The recipe/output stay.
    resetConversation();
  }

  function setParam(name: string, value: string | number | boolean) {
    const values = { ...paramValues, [name]: value };
    setParamValues(values);
    // Debounce the re-run so typing in a combobox doesn't fire on every keystroke
    // (partial values like "R" aren't valid columns).
    if (script) {
      if (paramRunTimer.current) clearTimeout(paramRunTimer.current);
      paramRunTimer.current = window.setTimeout(() => void run(script, values, inputs), 400);
    }
  }

  function toggleDataAccess(on: boolean) {
    setAllowDataAccess(on);
    localStorage.setItem("allowDataAccess.v1", on ? "1" : "0");
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
    await dataWorker.renameInput(inp.alias, next);
    const updated = inputs.map((i) => (i === inp ? { ...i, alias: next } : i));
    setInputs(updated);
    if (script) void run(script, paramValues, updated);
  }

  async function removeInput(target: InputFile) {
    const remaining = inputs.filter((i) => i !== target);
    await dataWorker.removeInput(target.alias);
    setInputs(remaining);
    setActiveInputIdx((idx) => Math.max(0, Math.min(idx, remaining.length - 1)));
    setAliasDraft((d) => {
      const n = { ...d };
      delete n[target.fileName];
      return n;
    });
    if (remaining.length === 0) {
      setOutput(null);
      setRunError(null);
    } else if (script) {
      void run(script, paramValues, remaining);
    }
  }

  async function saveToLibrary() {
    if (!script || saving) return;
    const payload = {
      script,
      params,
      param_values: paramValues,
      inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      prompt: userPrompts().slice(-1)[0],
      // NOTE: `steps` aren't persisted yet (no column server-side) — they live in
      // the downloaded .js metadata and the live authoring session only.
    };
    setSaving(true);
    try {
      if (currentRecipeId) {
        const d = await addVersion(currentRecipeId, payload);
        setLibMsg(`Saved v${d.current_version?.version_no}`);
        await refreshVersions(currentRecipeId);
      } else {
        const name = currentRecipeName || userPrompts()[0]?.slice(0, 48) || "Untitled recipe";
        const d = await createRecipe({ name, ...payload });
        setCurrentRecipeId(d.id);
        setCurrentRecipeName(d.name);
        setLibMsg(`Saved “${d.name}”`);
      }
      await refreshLibrary();
    } catch (err) {
      setLibMsg(`Save failed: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function refreshVersions(id: string) {
    try {
      setVersions(await listVersions(id));
    } catch {
      setVersions([]);
    }
  }

  // Opening a saved recipe drops you into the focused "apply" view (drag files,
  // tweak knobs, run) rather than the authoring workspace.
  async function openRecipe(id: string) {
    if (openingId) return;
    setOpeningId(id);
    try {
      const d = await getRecipe(id);
      const recipe = applyRecipeFromDetail(d);
      if (!recipe) return;
      void dataWorker.clearInputs();
      setApplyState({ recipe, mode: "owner", recipeId: d.id });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setLibMsg(`Open failed: ${errorMessage(err)}`);
    } finally {
      setOpeningId(null);
    }
  }

  function openTemplate(t: Template) {
    void dataWorker.clearInputs();
    setShowGallery(false);
    setApplyState({ recipe: templateToApply(t), mode: "template" });
    window.history.pushState({}, "", `/t/${t.slug}`);
    setMeta(`${t.name} — ${APP_NAME}`, t.description);
    window.scrollTo({ top: 0 });
  }

  function openGallery() {
    setApplyState(null);
    setShowGallery(true);
    window.history.pushState({}, "", "/templates");
    setMeta(`Templates — ${APP_NAME}`, GALLERY_DESC);
    window.scrollTo({ top: 0 });
  }

  function exitApply() {
    const onDeepLink = /^\/(s|t|templates)/.test(window.location.pathname);
    setApplyState(null);
    setShowGallery(false);
    void dataWorker.clearInputs();
    if (onDeepLink) {
      window.history.pushState({}, "", "/");
      setMeta(APP_NAME, APP_TAGLINE);
      reset();
    }
  }

  // "Save a copy" from a shared recipe / template -> a new recipe in the library.
  async function saveSharedCopy(paramValues: ParamValues, ins: InputFile[]): Promise<string | null> {
    if (!applyState) return null;
    const r = applyState.recipe;
    const d = await createRecipe({
      name: applyState.mode === "template" ? r.name : `${r.name} (copy)`,
      script: r.script,
      params: r.params,
      param_values: paramValues,
      inputs: r.inputs.length ? r.inputs : ins.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      prompt: r.description,
    });
    await refreshLibrary();
    return d.name;
  }

  // "Edit recipe" from the owner's apply view -> load it into the authoring workspace.
  function editFromApply(ins: InputFile[], paramValues: ParamValues) {
    if (!applyState) return;
    const r = applyState.recipe;
    resetConversation();
    setScript(r.script);
    setParams(r.params);
    setParamValues(paramValues);
    setInputs(ins);
    setActiveInputIdx(0);
    setCurrentRecipeId(applyState.recipeId ?? null);
    setCurrentRecipeName(r.name);
    setExpectedInputs(r.inputs);
    if (applyState.recipeId) void refreshVersions(applyState.recipeId);
    setApplyState(null);
    if (ins.length) void run(r.script, paramValues, ins);
  }

  function startRename(r: RecipeSummary) {
    setRenamingId(r.id);
    setRenameDraft(r.name);
    setConfirmDeleteId(null);
  }

  async function commitRename(id: string) {
    const name = renameDraft.trim();
    setRenamingId(null);
    const existing = library.find((r) => r.id === id);
    if (!name || (existing && existing.name === name)) return;
    try {
      const d = await renameRecipe(id, name);
      if (id === currentRecipeId) setCurrentRecipeName(d.name);
      await refreshLibrary();
    } catch (err) {
      setLibMsg(`Rename failed: ${errorMessage(err)}`);
    }
  }

  async function removeRecipe(id: string) {
    setDeletingId(id);
    try {
      await deleteRecipe(id);
      if (id === currentRecipeId) {
        setCurrentRecipeId(null);
        setCurrentRecipeName("");
        setVersions([]);
      }
      setLibMsg("Recipe deleted");
      await refreshLibrary();
    } catch (err) {
      setLibMsg(`Delete failed: ${errorMessage(err)}`);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  async function openShare(r: RecipeSummary) {
    setConfirmDeleteId(null);
    setCopiedShare(false);
    setSharePanelId(r.id);
    if (!r.share_token) {
      setSharingId(r.id);
      try {
        await shareRecipe(r.id);
        await refreshLibrary();
      } catch (err) {
        setLibMsg(`Share failed: ${errorMessage(err)}`);
        setSharePanelId(null);
      } finally {
        setSharingId(null);
      }
    }
  }

  async function stopSharing(id: string) {
    try {
      await unshareRecipe(id);
      await refreshLibrary();
    } catch (err) {
      setLibMsg(`Couldn't stop sharing: ${errorMessage(err)}`);
    } finally {
      setSharePanelId(null);
    }
  }

  async function copyShareLink(token: string) {
    try {
      await navigator.clipboard.writeText(shareLink(token));
      setCopiedShare(true);
    } catch {
      /* clipboard may be blocked; the link is selectable in the field */
    }
  }

  async function onSignedIn(email: string) {
    setUser(email);
    setAuthOpen(false);
    await refreshLibrary(); // ownership changed — show the account's library
  }

  async function signOut() {
    try {
      await authLogout();
    } catch {
      /* ignore */
    }
    setUser(null);
    setCurrentRecipeId(null);
    setVersions([]);
    await refreshLibrary();
  }

  function resetConversation() {
    agentAbort.current?.abort();
    setTranscript([]);
    setAssistantText("");
    setActivities([]);
    setPendingQuestion(null);
    setAnswerText("");
    setGenerating(false);
    setGenError(null);
  }

  function reset() {
    setInputs([]);
    setScript(null);
    setParams([]);
    setSteps([]);
    setParamValues({});
    setOutput(null);
    setRunError(null);
    setFileError(null);
    setSuggestions([]);
    resetConversation();
    setCurrentRecipeId(null);
    setCurrentRecipeName("");
    setVersions([]);
    setExpectedInputs([]);
    setActiveInputIdx(0);
    setLibMsg(null);
    void dataWorker.clearInputs();
  }

  async function downloadTable(name: string) {
    if (exportingTable) return;
    setExportingTable(name);
    try {
      const { csv } = await dataWorker.exportTable(name);
      downloadBlob(`${name.replace(/\s+/g, "_")}.csv`, csv, "text/csv");
    } finally {
      setExportingTable(null);
    }
  }

  function downloadRecipeFile() {
    if (!script) return;
    const meta: RecipeMeta = {
      version: 2,
      name: currentRecipeName || "recipe",
      created: new Date().toISOString(),
      prompts: userPrompts(),
      inputs: inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })),
      // Bake the current knob values in as defaults so the standalone CLI
      // remembers the user's tweaks too.
      params: params.map((p) => (p.name in paramValues ? { ...p, default: paramValues[p.name] } : p)),
      steps,
    };
    downloadBlob(`${(meta.name || "recipe").replace(/\s+/g, "_")}.js`, buildRecipe(script, meta), "text/javascript");
  }

  const hasInputs = inputs.length > 0;
  const activeInput = inputs[Math.min(activeInputIdx, inputs.length - 1)] ?? null;
  const paramOptions = useParamOptions(params, inputs.map((i) => ({ alias: i.alias, columns: i.preview.columns })));

  const library_panel =
    library.length > 0 ? (
      <section className="card section library">
        <div className="card-header">
          <h2>Your recipes</h2>
          <span className="count">saved &amp; versioned on the server — recipes only, never your data</span>
        </div>
        <div className="card-body">
          <p className="reuse-hint">
            Next month, open one and drop your new files — it re-runs the same steps.
            {AUTH_ENABLED && !user && (
              <> · <button className="linklike" onClick={() => setAuthOpen(true)}>Sign in</button> to reach these from any device.</>
            )}
          </p>
          <ul className="recipe-list">
            {library.map((r) => (
              <li key={r.id} className={r.id === currentRecipeId ? "active" : ""}>
                <div className="recipe-row">
                  {renamingId === r.id ? (
                    <input
                      className="rename-input"
                      autoFocus
                      value={renameDraft}
                      aria-label="Recipe name"
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="recipe-name">{r.name}</span>
                  )}
                  <span className="muted">v{r.version_count} · {relTime(r.updated_at)}</span>
                  <button className="btn ghost" disabled={openingId === r.id} onClick={() => openRecipe(r.id)}>
                    {openingId === r.id ? <><span className="spinner" aria-hidden="true" />Opening…</> : "Open"}
                  </button>
                  <button
                    className={`icon-btn sm ${r.share_token ? "shared" : ""}`}
                    title={r.share_token ? "Shared — get the link" : "Share"}
                    aria-label="Share recipe"
                    disabled={sharingId === r.id}
                    onClick={() => openShare(r)}
                  >
                    {sharingId === r.id ? <span className="spinner" aria-hidden="true" /> : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="18" cy="5" r="2.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="6" cy="12" r="2.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="18" cy="19" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M8 10.9l8-4.8M8 13.1l8 4.8" stroke="currentColor" strokeWidth="1.6" /></svg>
                    )}
                  </button>
                  <button className="icon-btn sm" title="Rename" aria-label="Rename recipe" onClick={() => startRename(r)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 00-3-3L5 17v3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M13.5 6.5l3 3" stroke="currentColor" strokeWidth="1.7" /></svg>
                  </button>
                  <button className="icon-btn sm danger" title="Delete" aria-label="Delete recipe" onClick={() => { setConfirmDeleteId(r.id); setRenamingId(null); }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2m-7 0l1 12a1 1 0 001 1h4a1 1 0 001-1l1-12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </div>
                {confirmDeleteId === r.id && (
                  <div className="confirm-row">
                    <span>Delete “{r.name}” and its {r.version_count} version{r.version_count === 1 ? "" : "s"}? This can't be undone.</span>
                    <button className="btn danger" disabled={deletingId === r.id} onClick={() => removeRecipe(r.id)}>
                      {deletingId === r.id ? <><span className="spinner" aria-hidden="true" />Deleting…</> : "Delete"}
                    </button>
                    <button className="btn ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </div>
                )}
                {sharePanelId === r.id && r.share_token && (
                  <div className="share-row">
                    <span className="share-label">🔗 Anyone with this link can open &amp; run it (on their own files):</span>
                    <div className="share-link-row">
                      <input className="share-input" readOnly value={shareLink(r.share_token)} onFocus={(e) => e.currentTarget.select()} />
                      <button className="btn primary" onClick={() => copyShareLink(r.share_token!)}>{copiedShare ? "Copied ✓" : "Copy"}</button>
                      <button className="btn ghost" onClick={() => stopSharing(r.id)}>Stop sharing</button>
                    </div>
                  </div>
                )}
                {r.id === currentRecipeId && versions.length > 0 && (
                  <ul className="version-list">
                    {versions.map((v) => {
                      const settings = paramSettings(v.params, v.param_values);
                      return (
                        <li key={v.id}>
                          <span className="vno">v{v.version_no}</span>
                          <span className="muted">{relTime(v.created_at)}</span>
                          {v.prompt && <span className="vprompt">“{v.prompt}”</span>}
                          {settings.length > 0 && (
                            <span className="vsettings">
                              {settings.map((s) => (
                                <span className="vsetting" key={s.label}>
                                  {s.label}: <b>{s.value}</b>
                                </span>
                              ))}
                            </span>
                          )}
                        </li>
                      );
                    })}
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
          {/* "Framed" mark: a rounded tile of data cells, one turned to a gold spark */}
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true" shapeRendering="geometricPrecision">
            <rect x="3.4" y="3.4" width="25.2" height="25.2" rx="7" fill="var(--accent-tint)" stroke="var(--accent)" strokeWidth="1.7" />
            <rect x="8" y="8" width="6.4" height="6.4" rx="1.6" fill="var(--accent)" />
            <rect x="8" y="17.6" width="6.4" height="6.4" rx="1.6" fill="var(--accent)" />
            <rect x="17.6" y="17.6" width="6.4" height="6.4" rx="1.6" fill="var(--accent)" />
            <path d="M20.8 6.8 Q21.55 10.45 25.2 11.2 Q21.55 11.95 20.8 15.6 Q20.05 11.95 16.4 11.2 Q20.05 10.45 20.8 6.8 Z" fill="var(--spark)" stroke="var(--spark)" strokeWidth="0.35" strokeLinejoin="round" />
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
        {AUTH_ENABLED &&
          (user ? (
            <span className="account">
              <span className="account-email" title={user}>{user}</span>
              <button className="btn ghost" onClick={signOut}>Sign out</button>
            </span>
          ) : (
            <button className="btn" onClick={() => setAuthOpen(true)}>Sign in</button>
          ))}
        {hasInputs && (
          <button className="btn ghost" onClick={reset}>Start over</button>
        )}
      </div>

      {AUTH_ENABLED && authOpen && <AuthModal onClose={() => setAuthOpen(false)} onSignedIn={onSignedIn} />}

      <main>
        {applyState && (
          <ApplyView
            recipe={applyState.recipe}
            mode={applyState.mode}
            onEdit={applyState.mode === "owner" ? editFromApply : undefined}
            onSaveCopy={applyState.mode !== "owner" ? saveSharedCopy : undefined}
            onExit={exitApply}
          />
        )}

        {!applyState && showGallery && (
          <GalleryPage onOpen={openTemplate} onHome={exitApply} />
        )}

        {!applyState && !showGallery && !hasInputs && (
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

            <div className="templates-section">
              <div className="templates-head">
                <h2>Start from a template</h2>
                <span className="muted">ready-made recipes for common chores — click one, drop your file, done</span>
                <button className="linklike" style={{ marginLeft: "auto" }} onClick={openGallery}>Browse all →</button>
              </div>
              <div className="template-grid">
                {TEMPLATES.map((t) => (
                  <button className="template-card" key={t.slug} onClick={() => openTemplate(t)}>
                    <span className="template-icon" aria-hidden="true">{t.icon}</span>
                    <span className="template-body">
                      <span className="template-name">{t.name}</span>
                      <span className="template-desc">{t.description}</span>
                      <span className="template-cat">{t.category}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {library_panel && <div style={{ marginTop: 40 }}>{library_panel}</div>}
          </section>
        )}

        {!applyState && !showGallery && hasInputs && (
          <>
            <div className="header-row">
              <h2 className="page-title">{currentRecipeName || "Untitled recipe"}</h2>
            </div>

            {loadingMsg && <div className="status"><span className="spinner" aria-hidden="true" />{loadingMsg}</div>}
            {fileError && <div className="error">{fileError}</div>}

            <div className="workspace">
            <div className="workspace-builder">
            <section className="section">
              <div className="header-row" style={{ marginBottom: 10 }}>
                <h2 className="page-title" style={{ fontSize: 15 }}>
                  Your files <span className="muted">— rename a slot to reuse this recipe on next month's files</span>
                </h2>
              </div>
              <div className="input-tabs" role="tablist" aria-label="Input files">
                {inputs.map((inp, i) => (
                  <div
                    key={inp.fileName}
                    role="tab"
                    tabIndex={0}
                    aria-selected={i === activeInputIdx}
                    className={`input-tab ${i === activeInputIdx ? "active" : ""}`}
                    onClick={() => setActiveInputIdx(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveInputIdx(i);
                      }
                    }}
                  >
                    <span className="input-tab-label">{aliasDraft[inp.fileName] ?? inp.alias}</span>
                    <button
                      className="tab-close"
                      aria-label={`Remove ${inp.alias}`}
                      title="Remove this file"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeInput(inp);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <DropZone onFiles={handleFiles} compact label="+ Add file" />
              </div>
              {activeInput && (
                <div className="card" role="tabpanel" key={activeInput.fileName}>
                  <div className="card-header">
                    <input
                      className="alias-input"
                      value={aliasDraft[activeInput.fileName] ?? activeInput.alias}
                      aria-label="Slot name"
                      onChange={(e) => setAliasDraft({ ...aliasDraft, [activeInput.fileName]: e.target.value })}
                      onBlur={() => commitAlias(activeInput)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <span className="from-file">{activeInput.fileName}</span>
                  </div>
                  <DataTable preview={activeInput.preview} />
                </div>
              )}
            </section>

            <section className="card section describe">
              <div className="card-header">
                <h2>Describe what you need</h2>
                <span className="count">plain English — the AI writes the recipe</span>
              </div>
              <div className="card-body">
                {(transcript.length > 0 || generating) && (
                  <div className="chat-log" ref={chatLogRef}>
                    {chatEntries(transcript).map((m, i) => (
                      <div key={i} className={`chat-msg chat-${m.who}`}>
                        <div className="chat-bubble">{m.text}</div>
                      </div>
                    ))}

                    {generating && (
                      <div className="chat-msg chat-assistant">
                        <div className="chat-bubble chat-live">
                          {activities.length > 0 && (
                            <ul className="agent-activity">
                              {activities.map((a, i) => (
                                <li key={i} className={`act-${a.status}`}>
                                  {a.status === "running" ? (
                                    <span className="spinner act-spin" aria-hidden="true" />
                                  ) : (
                                    <span className="act-icon" aria-hidden="true">{a.status === "ok" ? "✓" : "!"}</span>
                                  )}
                                  {a.detail}
                                </li>
                              ))}
                            </ul>
                          )}
                          {(assistantText || activities.length === 0) && (
                            <div className="assistant-reply thinking">
                              <span className="spinner" aria-hidden="true" />
                              <span>{assistantText || "Thinking…"}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {genError && <div className="run-error" style={{ marginBottom: 12 }}><pre>{genError}</pre></div>}

                {!pendingQuestion && !generating && transcript.length === 0 && (loadingSuggestions || suggestions.length > 0) && (
                  <div className="suggestions">
                    <span className="suggestions-label">
                      {loadingSuggestions ? <><span className="spinner" aria-hidden="true" />Thinking of ideas…</> : "Try one:"}
                    </span>
                    {suggestions.map((s, i) => (
                      <button key={i} className="suggestion-chip" onClick={() => void runSuggestion(s)}>{s}</button>
                    ))}
                  </div>
                )}

                {pendingQuestion ? (
                  <div className="clarify">
                    <div className="describe-input">
                      <textarea
                        value={answerText}
                        autoFocus
                        placeholder="Type your answer…"
                        rows={2}
                        onChange={(e) => setAnswerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void answerQuestion();
                          }
                        }}
                      />
                      <button className="btn primary" disabled={!answerText.trim()} onClick={() => void answerQuestion()}>
                        Answer
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="describe-input">
                    <textarea
                      value={describeText}
                      disabled={generating}
                      placeholder={
                        transcript.length
                          ? 'Refine it — e.g. "group by Segment instead" or "only paid orders"'
                          : 'e.g. "join orders to customers, then total revenue by region as a bar chart"'
                      }
                      rows={2}
                      onChange={(e) => setDescribeText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void generate();
                        }
                      }}
                    />
                    {generating ? (
                      <button className="btn ghost" onClick={cancelGenerate}>Stop</button>
                    ) : (
                      <button className="btn primary" disabled={!describeText.trim()} onClick={() => void generate()}>
                        Generate
                      </button>
                    )}
                  </div>
                )}

                <label className="data-access">
                  <input
                    type="checkbox"
                    checked={allowDataAccess}
                    onChange={(e) => toggleDataAccess(e.target.checked)}
                  />
                  <span>
                    Let the AI look at sample values for more accurate recipes.
                    <span className="muted">
                      {" "}When on, small samples of your data are sent to the AI (Claude on AWS Bedrock); when off, only column names &amp; types are shared.
                    </span>
                  </span>
                </label>
              </div>
            </section>
            </div>{/* /workspace-builder */}

            <div className="workspace-appcol">
              <div className="header-row app-result-head" style={{ marginBottom: 10 }}>
                <h2 className="page-title" style={{ fontSize: 15 }}>Result</h2>
                {script && currentRecipeId && (
                  <div className="app-head-save">
                    {libMsg && <span className="saved-msg">{libMsg}</span>}
                    <button className="btn ghost" disabled={saving} onClick={saveToLibrary}>
                      {saving ? <><span className="spinner" aria-hidden="true" />Saving…</> : "Save new version"}
                    </button>
                  </div>
                )}
              </div>
              <div className="workspace-app">
              {script ? (
                <>
                  <RecipePanel
                    inputs={inputs.map((i) => i.alias)}
                    steps={steps}
                    tables={(output?.tables ?? []).map((t) => prettify(t.name))}
                    plots={(output?.plots ?? []).map((p) => p.name)}
                    script={script}
                    onScriptChange={setScript}
                    onDownload={downloadRecipeFile}
                  />

                  {params.length > 0 && (
                    <section className="card section">
                      <div className="card-header">
                        <h2>Adjustable settings</h2>
                        <span className="count">edits re-run instantly, in your browser</span>
                      </div>
                      <div className="card-body">
                        <div className="params-grid">
                          {params.map((p) => (
                            <ParamControl key={p.name} param={p} value={paramValues[p.name]} options={paramOptions[p.name]} onChange={(v) => setParam(p.name, v)} />
                          ))}
                        </div>
                      </div>
                    </section>
                  )}

                  {running && <div className="status"><span className="spinner" aria-hidden="true" />Running…</div>}
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
                            <button className="btn ghost" disabled={exportingTable === t.name} onClick={() => downloadTable(t.name)}>
                              {exportingTable === t.name ? <><span className="spinner" aria-hidden="true" />Preparing…</> : "Download CSV"}
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

                </>
              ) : (
                <div className="app-empty">
                  <div className="app-empty-inner">
                    <div className="app-empty-icon" aria-hidden="true">▤</div>
                    <div className="app-empty-title">Your result shows up here</div>
                    <p className="muted">Describe what you need on the left — or pick a suggestion — and the recipe, its controls, and the output appear here as a little app.</p>
                  </div>
                </div>
              )}
              </div>{/* /workspace-app */}
            </div>{/* /workspace-appcol */}
            </div>{/* /workspace */}

            {script && !currentRecipeId && (
              <div className="save-banner" role="status">
                <span className="save-banner-text">
                  <strong>Recipe ready — not saved yet.</strong> Save it to your library to re-run on next month's files.
                </span>
                <button className="btn primary" disabled={saving} onClick={saveToLibrary}>
                  {saving ? <><span className="spinner" aria-hidden="true" />Saving…</> : "Save to library"}
                </button>
              </div>
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

function shareLink(token: string): string {
  return `${window.location.origin}/s/${token}`;
}

// Client-side <head> updates for deep-linked routes (title + description + OG).
// Static prerendered pages (scripts/prerender.mjs) set these for crawlers too.
function setOg(prop: string, content: string) {
  let m = document.querySelector(`meta[property="${prop}"]`);
  if (!m) {
    m = document.createElement("meta");
    m.setAttribute("property", prop);
    document.head.appendChild(m);
  }
  m.setAttribute("content", content);
}

function setMeta(title: string, description: string) {
  document.title = title;
  let m = document.querySelector('meta[name="description"]');
  if (!m) {
    m = document.createElement("meta");
    m.setAttribute("name", "description");
    document.head.appendChild(m);
  }
  m.setAttribute("content", description);
  setOg("og:title", title);
  setOg("og:description", description);
  setOg("og:type", "website");
}

function applyRecipeFromDetail(d: RecipeDetail): ApplyRecipe | null {
  const cv = d.current_version;
  if (!cv) return null;
  return {
    name: d.name,
    description: (cv.prompt as string) || undefined,
    script: cv.script,
    params: (Array.isArray(cv.params) ? cv.params : []) as RecipeParam[],
    paramValues: (cv.param_values && typeof cv.param_values === "object" ? cv.param_values : {}) as ParamValues,
    inputs: (Array.isArray(cv.inputs) ? cv.inputs : []) as { alias: string; columns: string[] }[],
  };
}

function templateToApply(t: Template): ApplyRecipe {
  return {
    name: t.name,
    description: t.description,
    script: t.script,
    params: t.params,
    paramValues: defaultsOf(t.params),
    inputs: t.inputs,
    samples: t.samples,
  };
}

function applyRecipeFromShared(s: SharedRecipe): ApplyRecipe {
  return {
    name: s.name,
    description: (s.prompt as string) || undefined,
    script: s.script,
    params: (Array.isArray(s.params) ? s.params : []) as RecipeParam[],
    paramValues: (s.param_values && typeof s.param_values === "object" ? s.param_values : {}) as ParamValues,
    inputs: (Array.isArray(s.inputs) ? s.inputs : []) as { alias: string; columns: string[] }[],
  };
}

/** Translate an error's last line into something a non-technical
 * user can act on. Falls back to the raw last line if we don't recognise it. */

function downloadBlob(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
