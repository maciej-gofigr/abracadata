import { describe, expect, it } from "vitest";
import { chatEntries } from "./chat";
import type { AgentTurn } from "./agent";

describe("chatEntries", () => {
  it("flattens a full conversation into user/assistant bubbles", () => {
    const transcript: AgentTurn[] = [
      { role: "user", text: "total revenue by region" },
      // an assistant turn that narrates AND runs a tool
      { role: "assistant", text: "Let me check the columns.", tool_calls: [{ id: "t1", name: "run_recipe", input: {} }] },
      { role: "tool", results: [{ id: "t1", ok: true, content: { tables: [] } }] },
      { role: "assistant", text: "Totals revenue by region as a bar chart." },
    ];
    expect(chatEntries(transcript)).toEqual([
      { who: "user", text: "total revenue by region" },
      { who: "assistant", text: "Let me check the columns." },
      { who: "assistant", text: "Totals revenue by region as a bar chart." },
    ]);
  });

  it("surfaces a clarifying question and its answer", () => {
    const transcript: AgentTurn[] = [
      { role: "user", text: "clean it up" },
      { role: "assistant", tool_calls: [{ id: "a1", name: "ask_user", input: { question: "Which column is the date?" } }] },
      { role: "tool", results: [{ id: "a1", ok: true, content: { answer: "the Order Date column" } }] },
    ];
    expect(chatEntries(transcript)).toEqual([
      { who: "user", text: "clean it up" },
      { who: "assistant", text: "Which column is the date?" },
      { who: "user", text: "the Order Date column" },
    ]);
  });

  it("strips code fences from narration and drops empty turns", () => {
    const transcript: AgentTurn[] = [
      { role: "assistant", text: "Here:\n```python\nx=1\n```" },
      { role: "assistant", text: "   " },
    ];
    expect(chatEntries(transcript)).toEqual([{ who: "assistant", text: "Here:" }]);
  });
});
