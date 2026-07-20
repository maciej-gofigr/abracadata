import { useEffect, useState } from "react";
import { APP_NAME, APP_TAGLINE } from "./branding";
import { ChatPanel } from "./components/ChatPanel";
import { DataTable } from "./components/DataTable";
import { DiffSummary } from "./components/DiffSummary";
import { DropZone } from "./components/DropZone";
import { ScriptPanel } from "./components/ScriptPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { DEFAULT_MODEL, generateScript } from "./lib/llm";
import { pyWorker } from "./lib/pyodide";
import { buildRecipe, parseRecipe } from "./lib/recipe";
import type {
  ChatMessage,
  RunResult,
  Settings,
  TablePreview,
} from "./types";

const SETTINGS_KEY = "settings.v1";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return defaultSettings();
}

function defaultSettings(): Settings {
  return { apiKey: "", model: DEFAULT_MODEL, shareSampleRows: true };
}

interface InputState {
  fileName: string;
  preview: TablePreview;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState<InputState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [output, setOutput] = useState<RunResult | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Start downloading Pyodide right away so the first file load is fast.
  useEffect(() => {
    pyWorker.warmUp();
  }, []);

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setFileError(null);
    if (file.name.toLowerCase().endsWith(".py")) {
      await loadRecipeFile(file);
      return;
    }
    setLoadingFile(true);
    try {
      const buffer = await file.arrayBuffer();
      const { preview } = await pyWorker.loadFile(file.name, buffer);
      setInput({ fileName: file.name, preview });
      setOutput(null);
      setRunError(null);
      setMessages([]);
      // If a recipe is already loaded, apply it to the new file immediately.
      if (script) await runScript(script);
    } catch (err) {
      setFileError(errorMessage(err));
    } finally {
      setLoadingFile(false);
    }
  }

  async function loadRecipeFile(file: File) {
    const text = await file.text();
    const parsed = parseRecipe(text);
    if (!parsed) {
      setFileError(
        `${file.name} doesn't look like a recipe (no transform() function found).`,
      );
      return;
    }
    setScript(parsed.script);
    setPrompts(parsed.meta?.prompts ?? []);
    setOutput(null);
    setRunError(null);
    if (input) await runScript(parsed.script);
  }

  async function runScript(source: string) {
    setRunning(true);
    setRunError(null);
    try {
      const result = await pyWorker.runScript(source);
      setOutput(result);
    } catch (err) {
      setOutput(null);
      setRunError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function sendPrompt(promptText: string) {
    if (!settings.apiKey) {
      setSettingsOpen(true);
      return;
    }
    const history: ChatMessage[] = [
      ...messages,
      { role: "user", text: promptText },
    ];
    setMessages(history);
    setGenerating(true);
    try {
      const { text, script: newScript } = await generateScript(
        settings,
        input,
        history,
      );
      setMessages([...history, { role: "assistant", text }]);
      if (newScript) {
        setScript(newScript);
        setPrompts((p) => [...p, promptText]);
        if (input) await runScript(newScript);
      }
    } catch (err) {
      setMessages([
        ...history,
        { role: "assistant", text: `Something went wrong: ${errorMessage(err)}` },
      ]);
    } finally {
      setGenerating(false);
    }
  }

  async function downloadOutput() {
    if (!input) return;
    const { csv } = await pyWorker.exportOutput();
    const base = input.fileName.replace(/\.[^.]+$/, "");
    downloadBlob(`${base}-transformed.csv`, csv, "text/csv");
  }

  function saveRecipe() {
    if (!script) return;
    const name = prompts[0]
      ? slugify(prompts[0])
      : input
        ? slugify(input.fileName.replace(/\.[^.]+$/, ""))
        : "recipe";
    const content = buildRecipe(script, {
      version: 1,
      name,
      created: new Date().toISOString(),
      prompts,
      expectedColumns: input?.preview.columns ?? [],
    });
    downloadBlob(`${name}.py`, content, "text/x-python");
  }

  return (
    <div className="app">
      <header>
        <div>
          <h1>{APP_NAME}</h1>
          <p className="tagline">{APP_TAGLINE}</p>
        </div>
        <button className="link-btn" onClick={() => setSettingsOpen(true)}>
          {settings.apiKey ? "Settings" : "Set API key"}
        </button>
      </header>

      {!input && (
        <DropZone
          onFiles={handleFiles}
          label="Drop a CSV or Excel file here (or a saved recipe .py)"
          hint="Everything runs in your browser — your data never leaves this machine."
        />
      )}
      {loadingFile && (
        <div className="status">
          Loading file… (the first load also downloads the Python runtime,
          ~10s)
        </div>
      )}
      {fileError && <div className="error">{fileError}</div>}

      {input && (
        <main className="columns">
          <section className="data-col">
            <div className="card">
              <div className="card-header">
                <h2>Input · {input.fileName}</h2>
                <DropZone
                  onFiles={handleFiles}
                  label="Replace file"
                  compact
                />
              </div>
              <DataTable preview={input.preview} />
            </div>
            {output && (
              <div className="card">
                <div className="card-header">
                  <h2>Output</h2>
                  <button onClick={downloadOutput}>Download CSV</button>
                </div>
                <DiffSummary diff={output.diff} />
                <DataTable preview={output.preview} />
              </div>
            )}
          </section>
          <aside className="chat-col">
            <ChatPanel
              messages={messages}
              busy={generating || running}
              disabled={!input}
              runError={runError}
              onSend={sendPrompt}
            />
            <ScriptPanel
              script={script}
              running={running}
              canRun={!!input}
              onChange={setScript}
              onRun={() => script && runScript(script)}
              onSaveRecipe={saveRecipe}
            />
          </aside>
        </main>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "recipe"
  );
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
