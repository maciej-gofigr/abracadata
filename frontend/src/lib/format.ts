import type { RecipeParam } from "../types";

/** Turn machine-y output names (`orders_per_customer`) into a friendly heading
 * ("Orders per customer") for display. The recipe still uses the raw name. */
export function prettify(name: string): string {
  const s = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return name;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
