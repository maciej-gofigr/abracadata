import type { RecipeParam } from "../types";

// Curated starter recipes. Each is a real, tested transform(inputs, params) that
// works on the user's own files — column names are resolved case-insensitively
// and are adjustable via knobs. Opening one drops you into the apply screen.

export interface Template {
  slug: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  script: string;
  params: RecipeParam[];
  inputs: { alias: string; columns: string[] }[];
}

// Shared helper injected at the top of every template script.
const HELPER = `import pandas as pd

def _col(df, name):
    m = {str(c).strip().lower(): c for c in df.columns}
    k = str(name).strip().lower()
    if k not in m:
        raise KeyError("Column '%s' not found. Columns in your file: %s" % (name, ", ".join(str(c) for c in df.columns)))
    return m[k]
`;

export const TEMPLATES: Template[] = [
  {
    slug: "total-by-category",
    name: "Total by category",
    category: "Summarize",
    icon: "📊",
    description: "Group a file by a category column and total up a value — with a bar chart. The classic pivot-table summary.",
    params: [
      { name: "category_column", label: "Group by column", type: "text", default: "Category", help: "The column to group rows by" },
      { name: "value_column", label: "Value to total", type: "text", default: "Amount", help: "The number column to sum" },
    ],
    inputs: [{ alias: "data", columns: ["Category", "Amount"] }],
    script: `${HELPER}
def transform(inputs, params):
    df = next(iter(inputs.values())).copy()
    cat = _col(df, params.get("category_column", "Category"))
    val = _col(df, params.get("value_column", "Amount"))
    df[val] = pd.to_numeric(df[val], errors="coerce")
    out = (df.groupby(cat, as_index=False)[val].sum()
             .sort_values(val, ascending=False)
             .rename(columns={val: "Total"}))
    out["Total"] = out["Total"].round(2)
    chart = plot_bar(out[cat].astype(str), out["Total"], title="Total by %s" % cat, ylabel="Total")
    return {"tables": {"Summary": out}, "plots": {"Total by category": chart}}
`,
  },
  {
    slug: "top-n",
    name: "Top N by value",
    category: "Summarize",
    icon: "🏆",
    description: "Find the biggest rows by any number column — your top customers, largest orders, best sellers.",
    params: [
      { name: "value_column", label: "Rank by column", type: "text", default: "Amount", help: "The number column to sort by" },
      { name: "top_n", label: "How many", type: "number", default: 10, min: 1, help: "Number of top rows to keep" },
    ],
    inputs: [{ alias: "data", columns: ["Name", "Amount"] }],
    script: `${HELPER}
def transform(inputs, params):
    df = next(iter(inputs.values())).copy()
    val = _col(df, params.get("value_column", "Amount"))
    n = max(1, int(params.get("top_n", 10)))
    df[val] = pd.to_numeric(df[val], errors="coerce")
    out = df.sort_values(val, ascending=False).head(n).reset_index(drop=True)
    label = df.columns[0]
    chart = plot_bar(out[label].astype(str), out[val], title="Top %d by %s" % (n, val))
    return {"tables": {"Top %d" % n: out}, "plots": {"Top items": chart}}
`,
  },
  {
    slug: "monthly-totals",
    name: "Monthly totals",
    category: "Summarize",
    icon: "📅",
    description: "Roll a dated file up into a total per month — spot trends across the year at a glance.",
    params: [
      { name: "date_column", label: "Date column", type: "text", default: "Date" },
      { name: "value_column", label: "Value to total", type: "text", default: "Amount" },
    ],
    inputs: [{ alias: "data", columns: ["Date", "Amount"] }],
    script: `${HELPER}
def transform(inputs, params):
    df = next(iter(inputs.values())).copy()
    dcol = _col(df, params.get("date_column", "Date"))
    vcol = _col(df, params.get("value_column", "Amount"))
    df[dcol] = pd.to_datetime(df[dcol], errors="coerce")
    df[vcol] = pd.to_numeric(df[vcol], errors="coerce")
    df = df.dropna(subset=[dcol])
    df["Month"] = df[dcol].dt.to_period("M").astype(str)
    out = (df.groupby("Month", as_index=False)[vcol].sum().rename(columns={vcol: "Total"}))
    out["Total"] = out["Total"].round(2)
    chart = plot_line(out["Month"], out["Total"], title="Total by month", xlabel="Month", ylabel="Total")
    return {"tables": {"By month": out}, "plots": {"Monthly total": chart}}
`,
  },
  {
    slug: "merge-two-files",
    name: "Look up values from another file",
    category: "Combine",
    icon: "🔗",
    description: "Bring columns from a second file into your main file by a shared ID — a VLOOKUP that never breaks.",
    params: [{ name: "key_column", label: "Shared column (the key)", type: "text", default: "ID", help: "The column both files have in common" }],
    inputs: [
      { alias: "main", columns: ["ID", "…"] },
      { alias: "lookup", columns: ["ID", "…"] },
    ],
    script: `${HELPER}
def transform(inputs, params):
    main = inputs["main"].copy()
    lookup = inputs["lookup"].copy()
    key = params.get("key_column", "ID")
    km = _col(main, key)
    kl = _col(lookup, key)
    merged = main.merge(lookup, left_on=km, right_on=kl, how="left", suffixes=("", " (lookup)"))
    if kl != km and kl in merged.columns:
        merged = merged.drop(columns=[kl])
    unmatched = int(merged[[c for c in lookup.columns if c != kl][0]].isna().sum()) if len(lookup.columns) > 1 else 0
    tables = {"Merged": merged}
    if unmatched:
        tables["Unmatched rows"] = merged[merged[[c for c in lookup.columns if c != kl][0]].isna()]
    return {"tables": tables, "plots": {}}
`,
  },
  {
    slug: "find-duplicates",
    name: "Find duplicate rows",
    category: "Clean",
    icon: "🧹",
    description: "Surface rows that repeat a value (same email, same ID) so you can dedupe with confidence.",
    params: [{ name: "key_column", label: "Column to check", type: "text", default: "ID", help: "Rows sharing this value are duplicates" }],
    inputs: [{ alias: "data", columns: ["ID"] }],
    script: `${HELPER}
def transform(inputs, params):
    df = next(iter(inputs.values())).copy()
    key = _col(df, params.get("key_column", "ID"))
    norm = df[key].astype(str).str.strip().str.lower()
    dup = norm.duplicated(keep=False)
    return {"tables": {"Duplicates": df[dup].sort_values(key), "Unique rows": df[~dup]}, "plots": {}}
`,
  },
  {
    slug: "whats-missing",
    name: "What's in one list but not the other",
    category: "Combine",
    icon: "⚖️",
    description: "Reconcile two lists — e.g. invoices not yet paid, or customers missing from a report. Rows in A whose key isn't in B.",
    params: [{ name: "key_column", label: "Column to match on", type: "text", default: "ID" }],
    inputs: [
      { alias: "list_a", columns: ["ID"] },
      { alias: "list_b", columns: ["ID"] },
    ],
    script: `${HELPER}
def transform(inputs, params):
    a = inputs["list_a"].copy()
    b = inputs["list_b"].copy()
    key = params.get("key_column", "ID")
    ka = _col(a, key)
    kb = _col(b, key)
    bset = set(b[kb].astype(str).str.strip().str.lower())
    missing = a[~a[ka].astype(str).str.strip().str.lower().isin(bset)]
    return {"tables": {"In list_a but not list_b": missing}, "plots": {}}
`,
  },
];

export const TEMPLATE_CATEGORIES = ["Summarize", "Combine", "Clean"];

export function templateBySlug(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}
