// Frontend agent loop for recipe generation.
//
// The backend (/api/generate) is a stateless per-turn oracle: each call returns
// either tool calls to run or a final recipe. This module owns the loop —
// executing tools in the Pyodide worker, feeding results/errors back, handling
// clarifying questions, and bounding the whole thing. See docs/agent-harness-design.md.

import { pyWorker } from "./pyodide";
import type { RecipeParam, RecipeStep } from "../types";

export interface AgentInputSchema {
  alias: string;
  columns: string[];
  dtypes: string[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  id: string;
  ok: boolean;
  content: unknown;
}

/** One entry in the running transcript (owned by the caller across user turns). */
export interface AgentTurn {
  role: "user" | "assistant" | "tool";
  text?: string | null;
  tool_calls?: AgentToolCall[];
  results?: AgentToolResult[];
}

export interface AgentActivity {
  tool: string;
  /** Human-readable step, e.g. "Testing the recipe…". */
  detail: string;
  status: "running" | "ok" | "error";
}

export interface AgentCallbacks {
  onText?: (delta: string) => void;
  onActivity?: (activities: AgentActivity[]) => void;
  onQuestion?: (question: string, askId: string | null) => void;
  onFinal?: (result: { script: string; params: RecipeParam[]; steps: RecipeStep[]; explanation: string }) => void;
  onError?: (message: string) => void;
}

export interface AgentOptions {
  allowDataAccess: boolean;
  maxRounds?: number;
  signal?: AbortSignal;
}

type Terminal =
  | { type: "tool_use"; assistant: AgentTurn; calls: AgentToolCall[] }
  | { type: "final"; assistant: AgentTurn; submit_id: string | null; script: string; params: RecipeParam[]; steps: RecipeStep[]; explanation: string }
  | { type: "question"; assistant: AgentTurn; ask_id: string; question: string }
  | { type: "message"; assistant: AgentTurn; text: string }
  | { type: "error"; error: string };

const DEFAULT_MAX_ROUNDS = 6;

/**
 * Drive the agent to completion. `transcript` is mutated in place (turns are
 * appended) so the caller can persist it for follow-up revisions and for
 * resuming after a clarifying question.
 */
export async function runAgent(
  inputs: AgentInputSchema[],
  transcript: AgentTurn[],
  opts: AgentOptions,
  cb: AgentCallbacks,
): Promise<void> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const activities: AgentActivity[] = [];
  let emittedText = false; // any streamed text so far (across turns)

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) return;

    // Separate this turn's narration from the previous turn's with a blank line —
    // otherwise "…analyzing your data." + "I see several columns." glue together.
    let turnHasText = false;
    const onTurnText = (delta: string) => {
      if (!turnHasText && emittedText) cb.onText?.("\n\n");
      turnHasText = true;
      emittedText = true;
      cb.onText?.(delta);
    };

    let turn: Terminal;
    try {
      turn = await advanceTurn(inputs, transcript, opts.allowDataAccess, onTurnText, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) return;
      cb.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }

    if (turn.type === "error") {
      cb.onError?.(turn.error);
      return;
    }

    if (turn.type === "final") {
      // Record the outcome as a plain assistant turn (NOT the submit_recipe tool
      // call): Converse messages must alternate and every tool_use needs a
      // tool_result, so an unresolved submit call — or a synthetic result that
      // ends on a user turn — would break the next revision. A clean assistant
      // text turn keeps the transcript valid for follow-ups.
      transcript.push({ role: "assistant", text: turn.explanation || turn.assistant.text || "Recipe ready." });
      cb.onFinal?.({ script: turn.script, params: turn.params, steps: turn.steps ?? [], explanation: turn.explanation });
      return;
    }

    if (turn.type === "question") {
      // Keep the ask_user tool call — the user's answer becomes its tool_result.
      transcript.push(turn.assistant);
      cb.onQuestion?.(turn.question, turn.ask_id);
      return;
    }

    if (turn.type === "message") {
      // Model replied in prose without a tool call — record it and let the user reply.
      transcript.push({ role: "assistant", text: turn.text });
      cb.onQuestion?.(turn.text || "(the assistant didn't produce a recipe — try rephrasing)", null);
      return;
    }

    // tool_use — run each tool in the worker, append results, loop.
    transcript.push(turn.assistant);
    const results: AgentToolResult[] = [];
    for (const call of turn.calls) {
      if (opts.signal?.aborted) return;
      const activity: AgentActivity = { tool: call.name, detail: describeTool(call), status: "running" };
      activities.push(activity);
      cb.onActivity?.([...activities]);

      const content = await executeTool(call, opts.allowDataAccess);
      const ok = !isErrorResult(content);
      activity.status = ok ? "ok" : "error";
      activity.detail = describeToolDone(call, ok);
      cb.onActivity?.([...activities]);

      results.push({ id: call.id, ok, content });
    }
    transcript.push({ role: "tool", results });
  }

  cb.onError?.("The assistant took too many steps without finishing. Try simplifying or rephrasing the request.");
}

function isErrorResult(content: unknown): boolean {
  return !!content && typeof content === "object" && (content as { ok?: boolean }).ok === false;
}

async function executeTool(call: AgentToolCall, allowDataAccess: boolean): Promise<unknown> {
  const i = call.input || {};
  try {
    if (call.name === "preview_rows") {
      if (!allowDataAccess) return { ok: false, error: "Data access is off; sample rows are unavailable." };
      return await pyWorker.previewRows(String(i.alias ?? ""), Number(i.n) || 5);
    }
    if (call.name === "column_profile") {
      if (!allowDataAccess) return { ok: false, error: "Data access is off; column profiles are unavailable." };
      return await pyWorker.columnProfile(String(i.alias ?? ""), String(i.column ?? ""));
    }
    if (call.name === "run_recipe") {
      return await pyWorker.runRecipeTest(
        String(i.script ?? ""),
        (i.params as Record<string, unknown>) || {},
        allowDataAccess,
      );
    }
    return { ok: false, error: `Unknown tool: ${call.name}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function describeTool(c: AgentToolCall): string {
  const i = c.input || {};
  if (c.name === "preview_rows") return `Looking at a sample of “${i.alias}”…`;
  if (c.name === "column_profile") return `Checking the “${i.column}” values…`;
  if (c.name === "run_recipe") return "Testing the recipe on your data…";
  return "Working…";
}

function describeToolDone(c: AgentToolCall, ok: boolean): string {
  const i = c.input || {};
  if (c.name === "preview_rows") return `Read a sample of “${i.alias}”`;
  if (c.name === "column_profile") return `Checked the “${i.column}” values`;
  if (c.name === "run_recipe") return ok ? "Recipe ran successfully" : "Hit an error — fixing it…";
  return "Done";
}

/** One turn: POST the transcript, stream text, return the terminal event. */
async function advanceTurn(
  inputs: AgentInputSchema[],
  transcript: AgentTurn[],
  allowDataAccess: boolean,
  onText: ((delta: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Terminal> {
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ inputs, allow_data_access: allowDataAccess, transcript }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    return { type: "error", error: `Generation request failed (${resp.status}).` };
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let terminal: Terminal | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let payload: any;
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (payload.type) {
        terminal = payload as Terminal;
      } else if (typeof payload.text === "string") {
        onText?.(payload.text);
      }
    }
  }

  return terminal ?? { type: "error", error: "No response from the generator." };
}
