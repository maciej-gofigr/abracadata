import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { ApplyView, type ApplyRecipe } from "./ApplyView";

const recipe: ApplyRecipe = {
  name: "Total by category",
  description: "A template",
  script: "function transform(inputs, params) { return { tables: {}, plots: {} }; }",
  params: [],
  inputs: [{ alias: "data", columns: ["Category", "Amount"] }],
};

describe("ApplyView — saving while signed out", () => {
  it("asks for sign-in instead of failing, then finishes the save once signed in", async () => {
    const onSaveCopy = vi.fn().mockResolvedValue("Total by category");
    const onRequestSignIn = vi.fn();

    // Signed out: the save must defer, not error.
    const { rerender } = render(
      <ApplyView recipe={recipe} mode="template" canSave={false}
        onSaveCopy={onSaveCopy} onRequestSignIn={onRequestSignIn} onExit={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /sign up to save/i }));
    expect(onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(onSaveCopy).not.toHaveBeenCalled();
    expect(screen.queryByText(/save failed/i)).not.toBeInTheDocument();

    // Signing in flips canSave — the pending save must now complete on its own.
    // (The regression this guards: a deferred save captured the pre-sign-in
    // state, re-checked it, and bounced the user back to the modal.)
    rerender(
      <ApplyView recipe={recipe} mode="template" canSave={true}
        onSaveCopy={onSaveCopy} onRequestSignIn={onRequestSignIn} onExit={() => {}} />,
    );
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Saved .*to your library/i)).toBeInTheDocument();
    expect(screen.queryByText(/save failed/i)).not.toBeInTheDocument();
    expect(onRequestSignIn).toHaveBeenCalledTimes(1); // modal not re-opened
  });

  it("saves directly when already signed in", async () => {
    const onSaveCopy = vi.fn().mockResolvedValue("Copy");
    render(
      <ApplyView recipe={recipe} mode="shared" canSave={true}
        onSaveCopy={onSaveCopy} onRequestSignIn={() => {}} onExit={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save a copy/i }));
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(1));
  });
});
