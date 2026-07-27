import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { RecipePanel } from "./RecipePanel";
import type { RecipeStep } from "../types";

const steps: RecipeStep[] = [{ title: "Total revenue per segment" }];
const script = "import pandas as pd\n\ndef transform(inputs, params):\n    return {}";

function noop() {}

describe("RecipePanel", () => {
  it("defaults to the Steps view and switches to Code on tab click", () => {
    render(
      <RecipePanel inputs={["orders"]} steps={steps} tables={["By segment"]} plots={[]} script={script} onScriptChange={noop} onDownload={noop} />,
    );
    // Steps view is showing (flow step visible, no code textarea yet)
    expect(screen.getByText("Total revenue per segment")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const code = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(code.value).toContain("def transform");
  });

  it("shows only Code (no tabs) when there are no steps", () => {
    render(
      <RecipePanel inputs={["orders"]} steps={[]} tables={[]} plots={[]} script={script} onScriptChange={noop} onDownload={noop} />,
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
