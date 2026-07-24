import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { fmtTime } from '../lib/format';

function fmtUpdated(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export default function UploadScreen() {
  const createProject = useStore((s) => s.createProject);
  const uploadBusy = useStore((s) => s.uploadBusy);
  const uploadError = useStore((s) => s.uploadError);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const apiKey = useStore((s) => s.apiKey);
  const projects = useStore((s) => s.projects);
  const refreshProjects = useStore((s) => s.refreshProjects);
  const openProject = useStore((s) => s.openProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const onFile = useCallback(
    (file: File | undefined) => {
      if (file) createProject(file);
    },
    [createProject]
  );

  const onDelete = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`Permanently delete "${name}"? This removes its audio, images, and edits from this device — it can't be undone.`)) {
        return;
      }
      setDeletingId(id);
      try {
        await deleteProject(id);
      } finally {
        setDeletingId(null);
      }
    },
    [deleteProject]
  );

  return (
    <div className="upload-screen">
      <header className="upload-header">
        <div className="brand">
          <span className="brand-dot" /> Audio Scene Visualizer
        </div>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
          {apiKey ? 'API key ✓' : 'Set API key'}
        </button>
      </header>

      <div className="upload-body">
        <h1>Turn a recording into a video.</h1>
        <p className="muted">
          Upload your narration — it gets transcribed, split into scenes, and each scene gets an
          AI illustration, synced to your voice.
        </p>

        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${uploadBusy ? 'busy' : ''}`}
          onClick={() => !uploadBusy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!uploadBusy) onFile(e.dataTransfer.files[0]);
          }}
        >
          {uploadBusy ? (
            <div className="dz-inner">
              <div className="spinner" />
              <span>Reading audio…</span>
            </div>
          ) : (
            <div className="dz-inner">
              <div className="dz-icon">🎙️</div>
              <strong>Drop your audio here</strong>
              <span className="muted">or click to browse — mp3, wav, m4a · up to 60 min / 500 MB</span>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
            hidden
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        {uploadError && <div className="error-box">{uploadError}</div>}

        <ol className="steps muted">
          <li>Upload audio</li>
          <li>Auto-transcribe &amp; split into scenes</li>
          <li>Generate an illustration per scene</li>
          <li>Preview the full video</li>
        </ol>

        {projects.length > 0 && (
          <div className="project-library">
            <h2>Your projects</h2>
            <ul className="project-list">
              {projects.map((p) => (
                <li key={p.id} className="project-card">
                  <button className="project-card-main" onClick={() => openProject(p.id)} title={`Open "${p.name}"`}>
                    <span className="project-card-name">{p.name}</span>
                    <span className="project-card-meta muted small">
                      {fmtTime(p.duration)} · {p.transcribed ? `${p.sceneCount} scene${p.sceneCount === 1 ? '' : 's'}` : 'not transcribed'} · {fmtUpdated(p.updatedAt)}
                    </span>
                  </button>
                  <button
                    className="btn ghost danger small-btn"
                    disabled={deletingId === p.id}
                    onClick={() => onDelete(p.id, p.name)}
                    title="Delete permanently"
                  >
                    {deletingId === p.id ? 'Deleting…' : 'Delete'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
