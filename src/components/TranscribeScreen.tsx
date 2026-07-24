import { useStore } from '../store';
import { fmtTime } from '../lib/format';
import Waveform from './Waveform';

export default function TranscribeScreen() {
  const project = useStore((s) => s.project)!;
  const transcribing = useStore((s) => s.transcribing);
  const transcribeStatus = useStore((s) => s.transcribeStatus);
  const transcribeError = useStore((s) => s.transcribeError);
  const startTranscription = useStore((s) => s.startTranscription);
  const apiKey = useStore((s) => s.apiKey);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const chunks = project.chunks ?? [];
  const done = chunks.filter((c) => c.words).length;
  const started = chunks.length > 0;
  const progress = started ? done / chunks.length : 0;

  return (
    <div className="transcribe-screen">
      <div className="card">
        <div className="file-info">
          <div className="file-icon">🎙️</div>
          <div>
            <strong>{project.audioName}</strong>
            <div className="muted">{fmtTime(project.duration)}</div>
          </div>
        </div>

        <Waveform peaks={project.peaks} />

        {!apiKey && (
          <div className="hint-box">
            Transcription runs on your own Google Gemini API key.{' '}
            <button className="link" onClick={() => setSettingsOpen(true)}>
              Add your key
            </button>{' '}
            to continue — it stays on this device.
          </div>
        )}

        {transcribing ? (
          <div className="progress-block">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.max(4, progress * 100)}%` }} />
            </div>
            <div className="muted">{transcribeStatus ?? 'Working…'}</div>
          </div>
        ) : (
          <>
            {transcribeError && (
              <div className="error-box">
                Transcription failed: {transcribeError}
                {started && done > 0 && <div className="muted">Progress so far is saved — retrying resumes where it stopped.</div>}
              </div>
            )}
            <button className="btn primary big" onClick={startTranscription}>
              {transcribeError || (started && done > 0) ? 'Retry transcription' : 'Transcribe & build scenes'}
            </button>
            <p className="muted small">
              Detects spoken Bahasa Indonesia (mixed English is fine) with word-level timing, then splits it into
              10–30&nbsp;second scenes you can adjust.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
