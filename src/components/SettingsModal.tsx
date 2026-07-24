import { useState } from 'react';
import { useStore } from '../store';

export default function SettingsModal() {
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [value, setValue] = useState(apiKey);

  const save = () => {
    setApiKey(value);
    setSettingsOpen(false);
  };

  return (
    <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="field">
          <span>Google Gemini API key</span>
          <input
            type="password"
            placeholder="AIza…"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </label>
        <p className="muted small">
          Used for transcription, prompt drafting, and image generation. Stored only in this
          browser — it is sent to no one but Google. Get a free key at aistudio.google.com/apikey.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setSettingsOpen(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
