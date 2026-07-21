import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable } from "./DataTable";
import type { TablePreview } from "../types";

const preview: TablePreview = {
  columns: ["Region", "Total Revenue"],
  dtypes: ["object", "float64"],
  rows: [
    ["West", 4858],
    ["East", 3168],
  ],
  rowCount: 4,
};

describe("DataTable", () => {
  it("renders headers and cell values", () => {
    render(<DataTable preview={preview} />);
    expect(screen.getByText("Region")).toBeInTheDocument();
    expect(screen.getByText("Total Revenue")).toBeInTheDocument();
    expect(screen.getByText("West")).toBeInTheDocument();
    expect(screen.getByText("4858")).toBeInTheDocument();
  });

  it("notes truncation when rowCount exceeds the shown rows", () => {
    render(<DataTable preview={preview} maxRows={1} />);
    expect(screen.getByText(/Showing first 1 of 4 rows/i)).toBeInTheDocument();
  });
});
