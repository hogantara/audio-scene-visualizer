import { useState } from 'react';
import { useStore } from '../store';
import { fmtUSD } from '../lib/format';

export default function SettingsModal() {
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const usage = useStore((s) => s.project?.usage);
  const resetUsage = useStore((s) => s.resetUsage);
  const [value, setValue] = useState(apiKey);

  const save = () => {
    setApiKey(value);
    setSettingsOpen(false);
  };

  const calls = usage ? usage.transcribeCalls + usage.promptCalls + usage.imageCalls : 0;

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
        {usage && calls > 0 && (
          <div className="usage-panel">
            <div className="usage-panel-head">
              <span>Usage this project</span>
              <button className="btn ghost small-btn" onClick={resetUsage}>
                Reset
              </button>
            </div>
            <table className="usage-table">
              <tbody>
                <tr>
                  <td>Transcription</td>
                  <td>{usage.transcribeCalls} call{usage.transcribeCalls === 1 ? '' : 's'}</td>
                </tr>
                <tr>
                  <td>Prompt drafts</td>
                  <td>{usage.promptCalls} call{usage.promptCalls === 1 ? '' : 's'}</td>
                </tr>
                <tr>
                  <td>Images</td>
                  <td>
                    {usage.imagesGenerated} generated ({usage.imageCalls} call{usage.imageCalls === 1 ? '' : 's'})
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted small">
              ~{fmtUSD(usage.costUSD)} estimated so far, from {(usage.inputTokens + usage.outputTokens).toLocaleString()}{' '}
              tokens across {calls} call{calls === 1 ? '' : 's'}. Estimate only, from list pricing — not a bill from
              Google.
            </p>
          </div>
        )}
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
