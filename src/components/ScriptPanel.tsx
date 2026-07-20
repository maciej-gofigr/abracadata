import { useState } from "react";

interface Props {
  script: string | null;
  running: boolean;
  canRun: boolean;
  onChange: (script: string) => void;
  onRun: () => void;
  onSaveRecipe: () => void;
}

export function ScriptPanel({
  script,
  running,
  canRun,
  onChange,
  onRun,
  onSaveRecipe,
}: Props) {
  const [open, setOpen] = useState(false);

  if (script === null) return null;

  return (
    <div className="script-panel">
      <div className="script-header">
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Script
        </button>
        <div className="script-actions">
          <button onClick={onRun} disabled={!canRun || running}>
            {running ? "Running…" : "Re-run"}
          </button>
          <button onClick={onSaveRecipe}>Save recipe</button>
        </div>
      </div>
      {open && (
        <textarea
          className="script-editor"
          value={script}
          spellCheck={false}
          rows={16}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
