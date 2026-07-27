import type { RecipeParam } from "../types";

/** Turn machine-y output names (`orders_per_customer`) into a friendly heading
 * ("Orders per customer") for display. The recipe still uses the raw name. */
export function prettify(name: string): string {
  const s = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return name;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Translate an error's last line into plain, actionable language. */
export function friendlyRunError(trace: string): string {
  const last = trace.trim().split("\n").filter(Boolean).pop() ?? trace;
  let m: RegExpMatchArray | null;
  if ((m = last.match(/KeyError:\s*['"]?([^'"]+)/))) {
    return `The recipe looked for “${m[1]}” but couldn't find it — a column may be named differently in this file, or a file was dropped into the wrong slot.`;
  }
  if (last.includes("No input files loaded")) return "Drop your files first, then the recipe will run.";
  if ((m = last.match(/No output table named ['"]?([^'"]+)/))) return `The recipe didn't produce a “${m[1]}” table.`;
  if (last.includes("produced no output tables")) return "The recipe finished but produced no table to show.";
  if (last.match(/(ValueError|TypeError|AttributeError|MergeError):/)) {
    return `${last.replace(/^\w+Error:\s*/, "")} — this usually means the data looks different from what the recipe expects.`;
  }
  return last;
}

function formatValue(p: RecipeParam, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (p.type === "currency") return `$${value}`;
  if (p.type === "bool") return value ? "on" : "off";
  return String(value);
}

/** A recipe version's saved knob settings as {label, value} pairs for display.
 * Pairs the spec (labels, types) with the stored values; skips unknown knobs. */
export function paramSettings(params: unknown, values: unknown): { label: string; value: string }[] {
  if (!Array.isArray(params) || !values || typeof values !== "object") return [];
  const vals = values as Record<string, unknown>;
  return (params as RecipeParam[])
    .filter((p) => p && p.name in vals)
    .map((p) => ({ label: p.label || p.name, value: formatValue(p, vals[p.name]) }));
}
