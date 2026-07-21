// Web worker that owns the Pyodide runtime. All Python execution happens here
// so the UI thread never blocks. Pyodide is fetched from the CDN on first use
// (~10s cold start), then kept warm for the session.
//
// v2 recipe contract:
//   transform(inputs: dict[str, DataFrame], params: dict) -> {"tables": {...}, "plots": {...}}
// - multiple named inputs (keyed by alias)
// - 1+ output tables, 0+ Plotly figure specs (built as plain dicts — no plotly
//   installed in Pyodide; Plotly.js renders them on the main thread)

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.mjs";

const BOOTSTRAP = `
import io, json, traceback, inspect
import pandas as pd
import numpy as np

_state = {"inputs": {}, "outputs": {}}

def _json_default(o):
    if isinstance(o, np.integer): return int(o)
    if isinstance(o, np.floating): return float(o)
    if isinstance(o, np.bool_): return bool(o)
    if isinstance(o, np.ndarray): return o.tolist()
    if hasattr(o, "tolist"):
        try: return o.tolist()
        except Exception: return str(o)
    return str(o)

def _preview(df, n=50):
    head = df.head(n)
    return {
        "columns": [str(c) for c in df.columns],
        "dtypes": [str(t) for t in df.dtypes],
        "rows": json.loads(head.to_json(orient="values", date_format="iso")),
        "rowCount": int(len(df)),
    }

def _read(name):
    with open("/upload.bin", "rb") as f:
        data = f.read()
    buf = io.BytesIO(data)
    if name.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(buf)
    return pd.read_csv(buf)

# Dependency-free plot builders injected into every recipe's namespace. They
# return plain Plotly figure dicts; the browser renders them with Plotly.js.
PLOT_HELPERS = r"""
def _layout(title, xlabel, ylabel):
    lay = {}
    if title: lay["title"] = {"text": title}
    if xlabel: lay["xaxis"] = {"title": {"text": xlabel}}
    if ylabel: lay["yaxis"] = {"title": {"text": ylabel}}
    return lay
def plot_bar(x, y, title=None, xlabel=None, ylabel=None):
    return {"data": [{"type": "bar", "x": list(x), "y": list(y)}], "layout": _layout(title, xlabel, ylabel)}
def plot_line(x, y, title=None, xlabel=None, ylabel=None):
    return {"data": [{"type": "scatter", "mode": "lines+markers", "x": list(x), "y": list(y)}], "layout": _layout(title, xlabel, ylabel)}
def plot_scatter(x, y, title=None, xlabel=None, ylabel=None):
    return {"data": [{"type": "scatter", "mode": "markers", "x": list(x), "y": list(y)}], "layout": _layout(title, xlabel, ylabel)}
def plot_pie(labels, values, title=None):
    return {"data": [{"type": "pie", "labels": list(labels), "values": list(values)}], "layout": _layout(title, None, None)}
"""

def load_input(alias, name):
    try:
        df = _read(name)
        _state["inputs"][alias] = df
        return json.dumps({"ok": True, "preview": _preview(df)}, default=_json_default)
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=3)})

def clear_inputs():
    _state["inputs"] = {}
    _state["outputs"] = {}
    return json.dumps({"ok": True})

def rename_input(old, new):
    try:
        if old != new and old in _state["inputs"]:
            _state["inputs"][new] = _state["inputs"].pop(old)
        return json.dumps({"ok": True})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=3)})

def run_script(source, params_json):
    try:
        inputs = _state["inputs"]
        if not inputs:
            raise RuntimeError("No input files loaded yet.")
        params = json.loads(params_json) if params_json else {}
        ns = {}
        exec(PLOT_HELPERS, ns)
        exec(source, ns)
        fn = ns.get("transform")
        if not callable(fn):
            raise ValueError("Your recipe must define a transform(...) function.")
        copied = {k: v.copy() for k, v in inputs.items()}
        nargs = len(inspect.signature(fn).parameters)
        if nargs >= 2:
            result = fn(copied, params)
        elif nargs == 1:
            result = fn(next(iter(copied.values()))) if len(copied) == 1 else fn(copied)
        else:
            result = fn()
        tables, plots = {}, {}
        if isinstance(result, pd.DataFrame):
            tables["result"] = result
        elif isinstance(result, dict) and ("tables" in result or "plots" in result):
            for nm, df in (result.get("tables") or {}).items():
                if not isinstance(df, pd.DataFrame):
                    raise TypeError("Table '" + str(nm) + "' is not a DataFrame.")
                tables[str(nm)] = df
            for nm, fig in (result.get("plots") or {}).items():
                plots[str(nm)] = fig
        elif isinstance(result, dict):
            for nm, df in result.items():
                if not isinstance(df, pd.DataFrame):
                    raise TypeError("transform() must return a DataFrame or a {tables, plots} dict.")
                tables[str(nm)] = df
        else:
            raise TypeError("transform() must return a DataFrame or a {tables, plots} dict.")
        if not tables:
            raise ValueError("transform() produced no output tables.")
        _state["outputs"] = tables
        return json.dumps({
            "ok": True,
            "tables": [{"name": nm, "preview": _preview(df)} for nm, df in tables.items()],
            "plots": [{"name": nm, "figure": fig} for nm, fig in plots.items()],
        }, default=_json_default)
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=5)})

def export_table(name):
    try:
        df = _state["outputs"].get(name)
        if df is None:
            raise RuntimeError("No output table named '" + str(name) + "'.")
        return json.dumps({"ok": True, "csv": df.to_csv(index=False)})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc(limit=3)})
`;

interface WorkerRequest {
  id: number;
  type: "init" | "clearInputs" | "loadInput" | "renameInput" | "runScript" | "exportTable";
  alias?: string;
  oldAlias?: string;
  name?: string;
  buffer?: ArrayBuffer;
  script?: string;
  params?: string;
  table?: string;
}

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
    if (msg.type === "clearInputs") {
      const fn = py.globals.get("clear_inputs");
      raw = fn();
      fn.destroy();
    } else if (msg.type === "loadInput") {
      py.FS.writeFile("/upload.bin", new Uint8Array(msg.buffer!));
      const fn = py.globals.get("load_input");
      raw = fn(msg.alias, msg.name);
      fn.destroy();
    } else if (msg.type === "renameInput") {
      const fn = py.globals.get("rename_input");
      raw = fn(msg.oldAlias, msg.alias);
      fn.destroy();
    } else if (msg.type === "runScript") {
      const fn = py.globals.get("run_script");
      raw = fn(msg.script, msg.params ?? "");
      fn.destroy();
    } else if (msg.type === "exportTable") {
      const fn = py.globals.get("export_table");
      raw = fn(msg.table);
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
