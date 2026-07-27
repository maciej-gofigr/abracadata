import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { runRecipe } from "./recipeRuntime";
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
    expect(table.preview.columns).toEqual(["Region", "Orders", "Revenue"]);

    // revenue sorted descending
    const revIdx = table.preview.columns.indexOf("Revenue");
    const revs = table.preview.rows.map((r) => r[revIdx] as number);
    expect([...revs].sort((a, b) => b - a)).toEqual(revs);

    // total revenue equals the sum of orders with Amount >= 100
    const expected = orders.filter((o) => Number(o.Amount) >= 100).reduce((s, o) => s + Number(o.Amount), 0);
    expect(revs.reduce((a, b) => a + b, 0)).toBeCloseTo(expected, 2);

    // Plotly figure dict shape (rendered by Plotly.js unchanged)
    const fig = out.plots[0].figure as { data: { type: string; x: unknown[] }[]; layout: { title: { text: string } } };
    expect(fig.data[0].type).toBe("bar");
    expect(fig.data[0].x.length).toBe(revs.length);
    expect(fig.layout.title.text).toBe("Revenue by region");
  });

  it("cleans messy real-world data via op.parseNumber / op.yearMonth", () => {
    const messy = [
      { Amount: "$1,200.50", Date: "01/05/2024" }, // US date, currency string
      { Amount: "800", Date: "Jan 6, 2024" },      // month-name date
      { Amount: "$1,000", Date: "2024-02-03" },    // ISO date
      { Amount: "", Date: "2024-02-10" },          // blank amount -> dropped
    ];
    const source = `
      function transform(inputs, params) {
        const summary = inputs.sales
          .derive({ amt: d => op.parseNumber(d.Amount), ym: d => op.yearMonth(d.Date) })
          .filter(d => d.amt === d.amt) // drop NaN (unparseable amounts)
          .groupby('ym')
          .rollup({ Revenue: op.sum('amt') })
          .orderby('ym');
        return { tables: { 'By month': summary }, plots: {} };
      }`;
    const out = runRecipe(source, { sales: messy });
    const t = out.tables[0].preview;

    expect(t.columns).toEqual(["ym", "Revenue"]);
    const byMonth = Object.fromEntries(t.rows.map((r) => [r[0], r[1]]));
    expect(byMonth["2024-01"]).toBeCloseTo(2000.5, 2); // 1200.50 + 800
    expect(byMonth["2024-02"]).toBeCloseTo(1000, 2);   // 1000 ; blank row dropped
  });

  it("rejects a recipe that returns no table", () => {
    const bad = `function transform() { return { tables: {}, plots: {} }; }`;
    expect(() => runRecipe(bad, { orders })).toThrow(/at least one table/);
  });
});
