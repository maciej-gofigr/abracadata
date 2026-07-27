import { explanationOnly } from "./api";
import type { AgentTurn } from "./agent";

export type ChatBubble = { who: "user" | "assistant"; text: string };

/**
 * Flatten the agent transcript into displayable chat bubbles: user prompts,
 * assistant narration, clarifying questions (from the ask_user tool call), and
 * the user's answers (stored as ask_user tool results). Protocol-only turns
 * (bare tool_use / tool results that aren't answers) are dropped.
 */
export function chatEntries(transcript: AgentTurn[]): ChatBubble[] {
  const out: ChatBubble[] = [];
  for (const turn of transcript) {
    if (turn.role === "user") {
      const t = (turn.text || "").trim();
      if (t) out.push({ who: "user", text: t });
    } else if (turn.role === "assistant") {
      const t = explanationOnly(turn.text || "");
      if (t) out.push({ who: "assistant", text: t });
      const ask = turn.tool_calls?.find((c) => c.name === "ask_user");
      const q = ask && typeof ask.input?.question === "string" ? ask.input.question.trim() : "";
      if (q) out.push({ who: "assistant", text: q });
    } else if (turn.role === "tool") {
      for (const r of turn.results ?? []) {
        const c = r.content;
        if (c && typeof c === "object" && "answer" in c) {
          const a = String((c as { answer: unknown }).answer).trim();
          if (a) out.push({ who: "user", text: a });
        }
      }
    }
  }
  return out;
}
