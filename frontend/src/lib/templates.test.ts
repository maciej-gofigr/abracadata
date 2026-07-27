import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { TEMPLATES } from "./templates";
import { runRecipe, type Row } from "./recipeRuntime";

function parse(csv: string): Row[] {
  return Papa.parse<Row>(csv.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
}

describe("template recipes run on their sample data", () => {
  for (const t of TEMPLATES) {
    it(`${t.slug} runs and returns a table`, () => {
      const inputs = Object.fromEntries(t.samples.map((s) => [s.alias, parse(s.csv)]));
      const params = Object.fromEntries(t.params.map((p) => [p.name, p.default]));
      const out = runRecipe(t.script, inputs, params);
      expect(out.tables.length).toBeGreaterThan(0);
      expect(out.tables[0].rows.length).toBeGreaterThan(0);
      // every plot is a Plotly figure dict
      for (const p of out.plots) expect(Array.isArray((p.figure as { data: unknown[] }).data)).toBe(true);
    });
  }
});
