// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseFile, columnProfile, distinctValues, previewRows } from "./recipeData";

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("recipeData", () => {
  it("parses CSV with typed values and column order", () => {
    const { columns, rows } = parseFile("orders.csv", buf("Name,Amount\nAcme,100\nGlobex,250\n"));
    expect(columns).toEqual(["Name", "Amount"]);
    expect(rows).toEqual([
      { Name: "Acme", Amount: 100 },
      { Name: "Globex", Amount: 250 },
    ]);
  });

  it("parses Excel (SheetJS) and normalizes dates to ISO strings", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Name", "When"], ["Acme", new Date(Date.UTC(2024, 0, 5))]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const { columns, rows } = parseFile("data.xlsx", out);
    expect(columns).toEqual(["Name", "When"]);
    expect(rows[0].Name).toBe("Acme");
    // Excel dates round-trip through SheetJS; exact day can shift ±1 by timezone.
    expect(String(rows[0].When)).toMatch(/2024-01-0[456]/);
  });

  it("profiles numeric + categorical columns and lists distinct values", () => {
    const columns = ["Region", "Amount"];
    const rows = [
      { Region: "W", Amount: 10 },
      { Region: "E", Amount: 20 },
      { Region: "W", Amount: 30 },
    ];
    expect(columnProfile(columns, rows, "Amount")).toMatchObject({ ok: true, kind: "numeric", min: 10, max: 30, mean: 20 });
    const cat = columnProfile(columns, rows, "Region") as { kind: string; unique_count: number };
    expect(cat.kind).toBe("categorical");
    expect(cat.unique_count).toBe(2);
    expect(distinctValues(columns, rows, "region")).toEqual(["E", "W"]); // case-insensitive column match
    expect(previewRows(columns, rows, 2).rows.length).toBe(2);
  });
});
