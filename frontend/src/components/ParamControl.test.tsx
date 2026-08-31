import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ParamControl } from "./ParamControl";
import type { RecipeParam } from "../types";

// A template knob whose valid values come from the dropped file's columns.
const columnParam: RecipeParam = {
  name: "value_column",
  label: "Value to total",
  type: "text",
  source: { from: "columns", input: "data" },
  default: "Amount",
};
const fileColumns = ["description", "amount_usd", "category", "date"];

function noop() {}

describe("ParamControl — data-sourced choice", () => {
  it("renders a real dropdown listing the file's columns (not a bare text box)", () => {
    render(<ParamControl param={columnParam} value="amount_usd" options={fileColumns} onChange={noop} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("amount_usd");
    for (const c of fileColumns) expect(screen.getByRole("option", { name: c })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other…" })).toBeInTheDocument();
  });

  it("flags a default that isn't a column in this file", () => {
    // The screenshot's case: template defaults to "Amount", file has "amount_usd".
    render(<ParamControl param={columnParam} value="Amount" options={fileColumns} onChange={noop} />);
    expect(screen.getByRole("option", { name: /Amount — not in this file/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveClass("param-missing");
  });

  it("accepts a case-different match without flagging it", () => {
    // col() resolves case-insensitively, so "Category" is really the file's "category".
    render(<ParamControl param={columnParam} value="Category" options={fileColumns} onChange={noop} />);
    expect(screen.queryByRole("option", { name: /not in this file/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).not.toHaveClass("param-missing");
  });

  it("falls back to a free-text combobox when no options are known", () => {
    const { container } = render(<ParamControl param={columnParam} value="Amount" options={[]} onChange={noop} />);
    // an <input list> also reports role=combobox, so assert on the element itself
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("input.combobox-input")).toHaveValue("Amount");
  });
});
