import { useState } from "react";
import type { ChatMessage } from "../types";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  disabled: boolean;
  runError: string | null;
  onSend: (prompt: string) => void;
}

export function ChatPanel({ messages, busy, disabled, runError, onSend }: Props) {
  const [draft, setDraft] = useState("");

  const send = () => {
    const text = draft.trim();
    if (!text || busy || disabled) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            Describe a filter or transformation, e.g. “keep only rows where
            Amount is over 500, then total by Department”.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <div className="chat-role">{m.role === "user" ? "You" : "AI"}</div>
            <div className="chat-text">{stripCode(m.text)}</div>
          </div>
        ))}
        {busy && <div className="chat-msg chat-assistant">Thinking…</div>}
      </div>
      {runError && (
        <div className="run-error">
          <div className="run-error-title">The script failed:</div>
          <pre>{runError}</pre>
          <button
            disabled={busy}
            onClick={() =>
              onSend(
                `The script failed with this error — please fix it:\n\n${runError}`,
              )
            }
          >
            Ask AI to fix it
          </button>
        </div>
      )}
      <div className="chat-input">
        <textarea
          value={draft}
          placeholder={
            disabled
              ? "Drop a file first…"
              : "What should happen to this table?"
          }
          disabled={disabled}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <button onClick={send} disabled={busy || disabled || !draft.trim()}>
          {busy ? "Working…" : "Generate"}
        </button>
      </div>
    </div>
  );
}

/** Hide code blocks in chat — the script lives in the script panel. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "[script updated — see the Script panel]").trim();
}
