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
    {
      name: "group_by",
      label: "Group by",
      type: "enum",
      default: "Region",
      options: ["Region", "Segment"],
    },
  ],
  steps: [
    { title: "Combine orders with customer details" },
    { title: "Total revenue per region", detail: "Grouped by the chosen column" },
  ],
};

const script = `import pandas as pd

def transform(inputs, params):
    return {"tables": {"result": inputs["orders"]}, "plots": {}}`;

describe("recipe build/parse", () => {
  it("round-trips metadata and script", () => {
    const parsed = parseRecipe(buildRecipe(script, meta));
    expect(parsed).not.toBeNull();
    expect(parsed!.meta?.name).toBe("revenue by region");
    expect(parsed!.meta?.inputs.map((i) => i.alias)).toEqual(["orders", "customers"]);
    expect(parsed!.meta?.params.map((p) => p.name)).toEqual(["min_amount", "group_by"]);
    expect(parsed!.meta?.steps?.map((s) => s.title)).toEqual([
      "Combine orders with customer details",
      "Total revenue per region",
    ]);
    expect(parsed!.meta?.steps?.[1].detail).toBe("Grouped by the chosen column");
    expect(parsed!.script).toContain("def transform(inputs, params)");
  });

  it("emits a self-contained CLI with a flag per input and param", () => {
    const file = buildRecipe(script, meta);
    expect(file).toContain('if __name__ == "__main__":');
    expect(file).toContain('p.add_argument("--orders"');
    expect(file).toContain('p.add_argument("--customers"');
    expect(file).toContain('p.add_argument("--min_amount", type=float, default=100');
    expect(file).toContain('p.add_argument("--group_by", type=str, default="Region"');
    // plot helpers are injected so charts work when the recipe runs standalone
    expect(file).toContain("def plot_bar(");
  });

  it("returns null for a file that isn't a recipe", () => {
    expect(parseRecipe("print('hello')")).toBeNull();
  });
});
