import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { runRecipe, toPreview } from "./recipeRuntime";
import { SAMPLE_ORDERS_CSV, SAMPLE_CUSTOMERS_CSV } from "./fixtures";

function parse(csv: string): Record<string, unknown>[] {
  return Papa.parse(csv.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true })
    .data as Record<string, unknown>[];
}

const orders = parse(SAMPLE_ORDERS_CSV);
const customers = parse(SAMPLE_CUSTOMERS_CSV);

describe("JS recipe runtime (Arquero)", () => {
  it("runs join -> filter(param) -> groupby -> rollup, like the model would write", () => {
    const source = `
      function transform(inputs, params) {
        const min = params.min_amount ?? 0;
        const summary = inputs.orders
          .join_left(inputs.customers, ['Customer ID', 'Customer ID'])
          .params({ min })
          .filter((d, $) => d.Amount >= $.min)
          .groupby('Region')
          .rollup({ Orders: op.count(), Revenue: op.sum('Amount') })
          .orderby(aq.desc('Revenue'));
        return {
          tables: { 'By region': summary },
          plots: { 'Revenue by region': plotBar(summary.array('Region'), summary.array('Revenue'), { title: 'Revenue by region' }) },
        };
      }`;
    const out = runRecipe(source, { orders, customers }, { min_amount: 100 });

    const table = out.tables[0];
    expect(table.name).toBe("By region");
    expect(table.columns).toEqual(["Region", "Orders", "Revenue"]);

    const revs = table.rows.map((r) => r.Revenue as number);
    expect([...revs].sort((a, b) => b - a)).toEqual(revs); // sorted descending
    const expected = orders.filter((o) => Number(o.Amount) >= 100).reduce((s, o) => s + Number(o.Amount), 0);
    expect(revs.reduce((a, b) => a + b, 0)).toBeCloseTo(expected, 2);

    // Plotly figure dict shape (rendered by Plotly.js unchanged)
    const fig = out.plots[0].figure as { data: { type: string; x: unknown[] }[]; layout: { title: { text: string } } };
    expect(fig.data[0].type).toBe("bar");
    expect(fig.data[0].x.length).toBe(revs.length);
    expect(fig.layout.title.text).toBe("Revenue by region");

    // preview is capped + typed
    const preview = toPreview(table.columns, table.rows);
    expect(preview.dtypes).toEqual(["string", "number", "number"]);
    expect(preview.rows[0].length).toBe(3);
  });

  it("cleans messy real-world data via op.parseNumber / op.yearMonth", () => {
    const messy = [
      { Amount: "$1,200.50", Date: "01/05/2024" },
      { Amount: "800", Date: "Jan 6, 2024" },
      { Amount: "$1,000", Date: "2024-02-03" },
      { Amount: "", Date: "2024-02-10" }, // blank amount -> dropped
    ];
    const source = `
      function transform(inputs, params) {
        const summary = inputs.sales
          .derive({ amt: d => op.parseNumber(d.Amount), ym: d => op.yearMonth(d.Date) })
          .filter(d => d.amt === d.amt)
          .groupby('ym')
          .rollup({ Revenue: op.sum('amt') })
          .orderby('ym');
        return { tables: { 'By month': summary }, plots: {} };
      }`;
    const out = runRecipe(source, { sales: messy });
    const byMonth = Object.fromEntries(out.tables[0].rows.map((r) => [r.ym, r.Revenue]));
    expect(byMonth["2024-01"]).toBeCloseTo(2000.5, 2);
    expect(byMonth["2024-02"]).toBeCloseTo(1000, 2);
  });

  it("rejects a recipe that returns no table", () => {
    const bad = `function transform() { return { tables: {}, plots: {} }; }`;
    expect(() => runRecipe(bad, { orders })).toThrow(/at least one table/);
  });
});
