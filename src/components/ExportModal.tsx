import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { fmtTime } from '../lib/format';
import { exportVideo, ExportResult } from '../lib/exportVideo';

type Status = 'idle' | 'recording' | 'done' | 'error';

export default function ExportModal() {
  const project = useStore((s) => s.project)!;
  const imageUrls = useStore((s) => s.imageUrls);
  const audioUrl = useStore((s) => s.audioUrl);
  const setExportOpen = useStore((s) => s.setExportOpen);

  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultUrlRef = useRef<string | null>(null);

  const missingImages = project.scenes.filter((s) => s.imageStatus !== 'ready').length;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, []);

  const start = async () => {
    if (!audioUrl) {
      setError('The audio for this project is missing.');
      setStatus('error');
      return;
    }
    setStatus('recording');
    setProgress(0);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await exportVideo({ project, imageUrls, audioUrl }, setProgress, controller.signal);
      resultUrlRef.current = URL.createObjectURL(res.blob);
      setResult(res);
      setStatus('done');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const download = () => {
    if (!result || !resultUrlRef.current) return;
    const a = document.createElement('a');
    a.href = resultUrlRef.current;
    a.download = `${project.name || 'video'}.${result.ext}`;
    a.click();
  };

  const close = useCallback(() => {
    abortRef.current?.abort();
    setExportOpen(false);
  }, [setExportOpen]);

  // Escape closes the dialog, same as clicking the backdrop — but not mid-recording, where an
  // accidental keypress shouldn't silently kill a long export; the explicit "Cancel export" button covers that.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'recording') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, close]);

  const sizeMb = result ? (result.blob.size / 1e6).toFixed(1) : null;

  return (
    <div className="modal-backdrop" onClick={status === 'recording' ? undefined : close}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export video</h2>

        {status === 'idle' && (
          <>
            <p className="muted small">
              Renders the full episode to a <strong>1920×1080 MP4</strong> that matches the preview
              exactly — image, subtitle font, position, and timing — with your audio.
            </p>
            <ul className="export-facts muted small">
              <li>Resolution: 1080p (16:9)</li>
              <li>Length: {fmtTime(project.duration)}</li>
              <li>Scenes: {project.scenes.length}</li>
              {missingImages > 0 && (
                <li className="warn">
                  {missingImages} scene{missingImages > 1 ? 's' : ''} without an image will show a
                  colored placeholder (as in the preview)
                </li>
              )}
            </ul>
            <p className="muted small">
              Recording runs in real time, so it takes about as long as the episode ({fmtTime(project.duration)}).
              Keep this tab in the foreground while it records.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" onClick={start}>
                Start export
              </button>
            </div>
          </>
        )}

        {status === 'recording' && (
          <>
            <div className="progress-block">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.max(3, progress * 100)}%` }} />
              </div>
              <div className="muted small">
                Recording… {Math.round(progress * 100)}% ({fmtTime(progress * project.duration)} /{' '}
                {fmtTime(project.duration)})
              </div>
            </div>
            <p className="muted small">Keep this tab focused. Recording in the background can drop frames.</p>
            <div className="modal-actions">
              <button className="btn ghost danger" onClick={close}>
                Cancel export
              </button>
            </div>
          </>
        )}

        {status === 'done' && result && (
          <>
            <div className="export-done">✓ Export complete — {sizeMb} MB</div>
            {result.fallback && (
              <p className="muted small">
                This browser couldn't record MP4, so the file is <strong>WebM</strong> (same 1080p
                quality). It plays in most players; re-encode to MP4 if a tool needs it.
              </p>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
              <button className="btn primary" onClick={download}>
                ⇩ Download {result.ext.toUpperCase()}
              </button>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="error-box">Export failed: {error}</div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
              <button className="btn primary" onClick={start}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
