import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeEditor } from "./CodeEditor";

function noop() {}

describe("CodeEditor", () => {
  it("keeps the source in an editable textarea and highlights JavaScript tokens", () => {
    const src = "function transform(inputs, params) {\n  return { tables: {} }; // done\n}";
    const { container } = render(<CodeEditor value={src} onChange={noop} />);

    // The textarea is the source of truth and holds the raw code.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(src);

    // Prism tokenized it: keyword + comment spans exist, and the visible text matches.
    const pre = container.querySelector(".code-editor-pre")!;
    expect(pre.querySelector(".token.keyword")).not.toBeNull();
    expect(pre.querySelector(".token.comment")).not.toBeNull();
    expect(pre.textContent).toContain("function transform(inputs, params)");
  });
});
