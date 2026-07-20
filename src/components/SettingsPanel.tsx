import { DEFAULT_MODEL } from "../lib/llm";
import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onChange, onClose }: Props) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          Anthropic API key
          <input
            type="password"
            value={settings.apiKey}
            placeholder="sk-ant-…"
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          />
        </label>
        <p className="settings-note">
          Stored only in your browser (localStorage). Requests go directly
          from your browser to the Anthropic API — there is no server.
        </p>
        <label>
          Model
          <input
            type="text"
            value={settings.model}
            placeholder={DEFAULT_MODEL}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
          />
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.shareSampleRows}
            onChange={(e) =>
              onChange({ ...settings, shareSampleRows: e.target.checked })
            }
          />
          Send up to 20 sample rows to the AI (better results). Uncheck to
          send column names and types only.
        </label>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
