// Web worker that owns the Pyodide runtime. All Python execution happens
// here so the UI thread never blocks. Pyodide is fetched from the CDN on
// first use (~10s cold start), then kept warm for the session.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.mjs";

// Python-side plumbing. Every entry point returns a JSON string with an
// "ok" flag so errors surface as readable tracebacks, not opaque JS throws.
const BOOTSTRAP = `
import io, json, traceback
import pandas as pd

_state = {}

def _preview(df, n=100):
    head = df.head(n)
    return {
        "columns": [str(c) for c in df.columns],
        "dtypes": [str(t) for t in df.dtypes],
        "rows": json.loads(head.to_json(orient="values", date_format="iso")),
        "rowCount": int(len(df)),
    }

def load_file(name):
    try:
        with open("/upload.bin", "rb") as f:
            data = f.read()
        buf = io.BytesIO(data)
        if name.lower().endswith((".xlsx", ".xls")):
            df = pd.read_excel(buf)
        else:
            df = pd.read_csv(buf)
        _state["input"] = df
        _state.pop("output", None)
        return json.dumps({"ok": True, "preview": _preview(df)})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=3)})

def run_script(source):
    try:
        if "input" not in _state:
            raise RuntimeError("No input file loaded")
        ns = {}
        exec(source, ns)
        fn = ns.get("transform")
        if not callable(fn):
            raise ValueError("Script must define a function transform(df)")
        out = fn(_state["input"].copy())
        if not isinstance(out, pd.DataFrame):
            raise TypeError("transform() must return a pandas DataFrame")
        _state["output"] = out
        inp = _state["input"]
        in_cols = set(map(str, inp.columns))
        out_cols = set(map(str, out.columns))
        diff = {
            "rowsIn": int(len(inp)),
            "rowsOut": int(len(out)),
            "columnsAdded": sorted(out_cols - in_cols),
            "columnsRemoved": sorted(in_cols - out_cols),
        }
        return json.dumps({"ok": True, "preview": _preview(out), "diff": diff})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=5)})

def export_output():
    try:
        if "output" not in _state:
            raise RuntimeError("No output to export")
        return json.dumps({"ok": True, "csv": _state["output"].to_csv(index=False)})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=3)})
`;

interface WorkerRequest {
  id: number;
  type: "init" | "loadFile" | "runScript" | "exportOutput";
  name?: string;
  buffer?: ArrayBuffer;
  script?: string;
}

// Typed handle on the worker global scope without pulling in the WebWorker
// lib (which conflicts with DOM types in a single tsconfig).
const ctx = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let pyodidePromise: Promise<any> | null = null;

function getPyodide(): Promise<any> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const mod = await import(/* @vite-ignore */ PYODIDE_URL);
      const py = await mod.loadPyodide();
      await py.loadPackage(["pandas", "micropip"]);
      // openpyxl (for .xlsx) isn't bundled with Pyodide — pull the pure-Python
      // wheel from PyPI via micropip.
      await py.runPythonAsync(
        'import micropip\nawait micropip.install("openpyxl")',
      );
      py.runPython(BOOTSTRAP);
      return py;
    })();
  }
  return pyodidePromise;
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    const py = await getPyodide();
    if (msg.type === "init") {
      ctx.postMessage({ id: msg.id, ok: true, payload: null });
      return;
    }
    let raw = "";
    if (msg.type === "loadFile") {
      py.FS.writeFile("/upload.bin", new Uint8Array(msg.buffer!));
      const fn = py.globals.get("load_file");
      raw = fn(msg.name);
      fn.destroy();
    } else if (msg.type === "runScript") {
      const fn = py.globals.get("run_script");
      raw = fn(msg.script);
      fn.destroy();
    } else if (msg.type === "exportOutput") {
      const fn = py.globals.get("export_output");
      raw = fn();
      fn.destroy();
    }
    const parsed = JSON.parse(raw);
    if (parsed.ok) {
      ctx.postMessage({ id: msg.id, ok: true, payload: parsed });
    } else {
      ctx.postMessage({ id: msg.id, ok: false, error: parsed.error });
    }
  } catch (err) {
    ctx.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
