import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecipeFlow } from "./RecipeFlow";
import type { RecipeStep } from "../types";

const steps: RecipeStep[] = [
  { title: "Combine orders with customer details" },
  { title: "Total revenue per segment", detail: "Grouped by segment" },
];

describe("RecipeFlow", () => {
  it("renders input endcaps, numbered steps, and outputs", () => {
    render(<RecipeFlow inputs={["orders", "customers"]} steps={steps} tables={["By segment"]} plots={["Revenue share"]} />);
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("customers")).toBeInTheDocument();
    expect(screen.getByText("Combine orders with customer details")).toBeInTheDocument();
    expect(screen.getByText("Grouped by segment")).toBeInTheDocument();
    expect(screen.getByText("By segment")).toBeInTheDocument();
    expect(screen.getByText("Revenue share")).toBeInTheDocument();
    // steps are numbered 1..n
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders nothing without steps (no flow to show yet)", () => {
    const { container } = render(<RecipeFlow inputs={["orders"]} steps={[]} tables={[]} plots={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
