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
  // JS errors put the message on the FIRST line and stack frames after, so take
  // the first non-frame line (a bare stack frame is never a useful message).
  const lines = trace.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const msg = lines.find((l) => !l.startsWith("at ")) ?? lines[0] ?? trace;
  let m: RegExpMatchArray | null;

  // The runtime's col() resolver: name the column AND list what's available.
  if ((m = msg.match(/Column "([^"]+)" not found\.\s*Columns:\s*(.+)$/))) {
    const cols = m[2].split(",").map((c) => c.trim()).filter(Boolean);
    const shown = cols.slice(0, 8).map((c) => `“${c}”`).join(", ");
    const more = cols.length > 8 ? `, and ${cols.length - 8} more` : "";
    return `This file has no column named “${m[1]}”. Use the settings above to pick one of its actual columns: ${shown}${more}.`;
  }
  if ((m = msg.match(/KeyError:\s*['"]?([^'"]+)/))) {
    return `The recipe looked for “${m[1]}” but couldn't find it — a column may be named differently in this file, or a file was dropped into the wrong slot.`;
  }
  if (msg.includes("No input files loaded")) return "Drop your files first, then the recipe will run.";
  if ((m = msg.match(/No output table named ['"]?([^'"]+)/))) return `The recipe didn't produce a “${m[1]}” table.`;
  if (msg.includes("at least one table") || msg.includes("produced no output tables")) {
    return "The recipe finished but produced no table to show.";
  }
  if ((m = msg.match(/(?:\w*Error):\s*(.+)$/))) {
    return `${m[1]} — this usually means the data looks different from what the recipe expects.`;
  }
  return msg;
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
