import { useMemo } from "react";
import Prism from "prismjs"; // core bundles the JavaScript grammar — no component import needed

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A small editable code field with JavaScript syntax highlighting: a transparent
 * <textarea> overlays a Prism-highlighted <pre>, kept in perfect alignment by
 * sharing font/padding/wrapping. Avoids a heavy editor dependency (and its
 * older-React peer pins) while staying fully editable. Highlighting is a
 * read-only enhancement — the textarea remains the source of truth.
 */
export function CodeEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const grammar = Prism.languages.javascript;
  const html = useMemo(
    () => (grammar ? Prism.highlight(value, grammar, "javascript") : escapeHtml(value)),
    [value, grammar],
  );

  return (
    <div className="code-editor">
      {/* Trailing newline keeps the highlighted layer as tall as the textarea. */}
      <pre className="code-editor-pre" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: html + "\n" }} />
      </pre>
      <textarea
        className="code-editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Recipe code"
      />
    </div>
  );
}
