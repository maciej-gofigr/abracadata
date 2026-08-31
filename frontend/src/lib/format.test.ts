import { describe, expect, it } from "vitest";
import { friendlyRunError } from "./format";

// The real trace produced when a template's default column doesn't exist in the
// dropped file (JS puts the message FIRST and stack frames after).
const COLUMN_TRACE = `Error: Column "Amount" not found. Columns: description, type, account, account_type, date,  amount_usd , year, period, is_paycheck, is_tax, is_federal_tax, is_mass_tax, is_aws, subcontractors, jason, david, is_retirement, category, reviewed
    at col (http://10.0.0.50:5173/src/lib/recipeStdlib.ts:56:21)
    at transform (eval at runRecipe (http://10.0.0.50:5173/src/lib/recipeRuntime.ts:36:14), <anonymous>:7:15)
    at eval (eval at runRecipe (http://10.0.0.50:5173/src/lib/recipeRuntime.ts:36:14), <anonymous>:19:8)`;

describe("friendlyRunError", () => {
  it("explains a missing column and lists the file's actual columns", () => {
    const msg = friendlyRunError(COLUMN_TRACE);
    expect(msg).toContain("no column named “Amount”");
    expect(msg).toContain("settings above");
    expect(msg).toContain("“description”"); // shows real columns to pick from
    expect(msg).toContain("and 11 more"); // 19 columns, first 8 shown
    // never surfaces a raw stack frame as the "friendly" message
    expect(msg).not.toContain("at eval");
    expect(msg).not.toContain("http://");
  });

  it("never returns a bare stack frame for other JS errors", () => {
    const trace = `TypeError: d.Amount.toFixed is not a function\n    at eval (eval at runRecipe (http://x/y.ts:1:1), <anonymous>:3:9)`;
    const msg = friendlyRunError(trace);
    expect(msg).toContain("toFixed is not a function");
    expect(msg).not.toMatch(/^at /);
  });

  it("handles the no-table and no-input cases", () => {
    expect(friendlyRunError("Error: A recipe must return at least one table.")).toMatch(/no table to show/i);
    expect(friendlyRunError("Error: No input files loaded yet.")).toMatch(/Drop your files/i);
  });
});
