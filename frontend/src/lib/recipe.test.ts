import { describe, expect, it } from "vitest";
import { buildRecipe, parseRecipe } from "./recipe";
import type { RecipeMeta } from "../types";

const meta: RecipeMeta = {
  version: 2,
  name: "revenue by region",
  created: "2026-07-20T00:00:00.000Z",
  prompts: ["summarize revenue by region"],
  inputs: [
    { alias: "orders", columns: ["Order ID", "Amount"] },
    { alias: "customers", columns: ["Customer ID", "Region"] },
  ],
  params: [
    { name: "min_amount", label: "Minimum order amount", type: "currency", default: 100 },
  ],
  steps: [
    { title: "Combine orders with customer details" },
    { title: "Total revenue per region", detail: "Grouped by the chosen column" },
  ],
};

const script = `function transform(inputs, params) {
  return { tables: { result: inputs.orders }, plots: {} };
}`;

describe("recipe build/parse", () => {
  it("round-trips metadata and the JS transform", () => {
    const parsed = parseRecipe(buildRecipe(script, meta));
    expect(parsed).not.toBeNull();
    expect(parsed!.meta?.name).toBe("revenue by region");
    expect(parsed!.meta?.inputs.map((i) => i.alias)).toEqual(["orders", "customers"]);
    expect(parsed!.meta?.params.map((p) => p.name)).toEqual(["min_amount"]);
    expect(parsed!.meta?.steps?.map((s) => s.title)).toEqual([
      "Combine orders with customer details",
      "Total revenue per region",
    ]);
    expect(parsed!.script).toContain("function transform(inputs, params)");
  });

  it("returns null for a file that isn't a recipe", () => {
    expect(parseRecipe("console.log('hello')")).toBeNull();
  });
});
