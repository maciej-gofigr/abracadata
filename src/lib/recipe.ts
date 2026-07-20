import type { RecipeMeta, RecipeParam } from "../types";

// A v2 recipe is a self-contained Python file:
//   - a metadata header (JSON in comments): inputs (aliases), params, provenance
//   - dependency-free plot helpers (so charts work outside the app too)
//   - the transform(inputs, params) function
//   - a CLI entry point:  python recipe.py --orders o.csv --customers c.csv --min_amount 100

const META_START = "# === recipe metadata ===";
const META_END = "# === end recipe metadata ===";
const MAIN_GUARD = 'if __name__ == "__main__":';

const PLOT_HELPERS = `# --- plot helpers: dependency-free Plotly figure specs ---
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
    return {"data": [{"type": "pie", "labels": list(labels), "values": list(values)}], "layout": _layout(title, None, None)}`;

function pyLiteral(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

function argType(t: RecipeParam["type"]): string {
  if (t === "number" || t === "currency") return "float";
  if (t === "bool") return "bool";
  return "str";
}

export function buildRecipe(script: string, meta: RecipeMeta): string {
  const metaLines = JSON.stringify(meta, null, 2)
    .split("\n")
    .map((l) => "# " + l)
    .join("\n");
  const cli = buildCli(meta);
  return `${META_START}\n${metaLines}\n${META_END}\n\n${PLOT_HELPERS}\n\n${script.trim()}\n${cli}`;
}

function buildCli(meta: RecipeMeta): string {
  const aliases = meta.inputs.map((i) => i.alias);
  const addInputs = aliases
    .map(
      (a) =>
        `    p.add_argument("--${a}", required=True, help="Path to the '${a}' input (CSV or Excel)")`,
    )
    .join("\n");
  const addParams = meta.params
    .map(
      (pr) =>
        `    p.add_argument("--${pr.name}", type=${argType(pr.type)}, default=${pyLiteral(pr.default)}, help=${JSON.stringify(pr.label)})`,
    )
    .join("\n");
  const inputsDict = aliases.map((a) => `        "${a}": _read(args.${a}),`).join("\n");
  const paramsDict = meta.params.map((pr) => `        "${pr.name}": args.${pr.name},`).join("\n");
  return `
${MAIN_GUARD}
    import argparse, json, os
    import pandas as pd
    p = argparse.ArgumentParser(description=${JSON.stringify(meta.name)})
${addInputs || "    pass"}
${addParams}
    p.add_argument("-o", "--output-dir", default=".")
    args = p.parse_args()

    def _read(path):
        return pd.read_excel(path) if path.lower().endswith((".xlsx", ".xls")) else pd.read_csv(path)

    inputs = {
${inputsDict}
    }
    params = {
${paramsDict}
    }
    result = transform(inputs, params)
    if isinstance(result, pd.DataFrame):
        result = {"tables": {"result": result}, "plots": {}}
    os.makedirs(args.output_dir, exist_ok=True)
    for _name, _df in (result.get("tables") or {}).items():
        _path = os.path.join(args.output_dir, _name.replace(" ", "_") + ".csv")
        _df.to_csv(_path, index=False)
        print("wrote", _path)
    for _name, _fig in (result.get("plots") or {}).items():
        _base = os.path.join(args.output_dir, _name.replace(" ", "_"))
        try:
            import plotly.graph_objects as go
            go.Figure(_fig).write_html(_base + ".html")
            print("wrote", _base + ".html")
        except Exception:
            with open(_base + ".json", "w") as _f:
                json.dump(_fig, _f)
            print("wrote", _base + ".json", "(pip install plotly for an HTML chart)")
`;
}

export interface ParsedRecipe {
  meta: RecipeMeta | null;
  script: string;
}

/** Parse a .py recipe back into (metadata, transform script). */
export function parseRecipe(text: string): ParsedRecipe | null {
  if (!text.includes("def transform")) return null;
  let meta: RecipeMeta | null = null;
  let body = text;

  const start = text.indexOf(META_START);
  const end = text.indexOf(META_END);
  if (start !== -1 && end !== -1 && end > start) {
    const rawMeta = text
      .slice(start + META_START.length, end)
      .split("\n")
      .map((l) => l.replace(/^#\s?/, ""))
      .join("\n");
    try {
      meta = JSON.parse(rawMeta) as RecipeMeta;
    } catch {
      meta = null;
    }
    body = text.slice(end + META_END.length);
  }

  const guardIdx = body.indexOf(MAIN_GUARD);
  const script = (guardIdx === -1 ? body : body.slice(0, guardIdx)).trim();
  return { meta, script };
}
