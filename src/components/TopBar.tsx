import { useState } from 'react';
import { ArrowCounterClockwise, ArrowClockwise, DownloadSimple, Keyboard } from '@phosphor-icons/react';
import { useStore } from '../store';
import { mod } from '../lib/keyboard';
import { fmtIDR } from '../lib/format';
import ShortcutsModal from './ShortcutsModal';

export default function TopBar() {
  const project = useStore((s) => s.project)!;
  const setName = useStore((s) => s.setName);
  const savedAt = useStore((s) => s.savedAt);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setExportOpen = useStore((s) => s.setExportOpen);
  const backToLibrary = useStore((s) => s.backToLibrary);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.historyPast.length > 0);
  const canRedo = useStore((s) => s.historyFuture.length > 0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        <input
          className="project-name"
          value={project.name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Project name"
        />
      </div>
      <div className="topbar-right">
        <span className="muted small">{savedAt ? 'Saved' : 'Autosave on'}</span>
        {project.usage &&
          project.usage.transcribeCalls + project.usage.promptCalls + project.usage.imageCalls > 0 && (
            <button
              className="btn ghost small-btn usage-badge"
              onClick={() => setSettingsOpen(true)}
              title={`Estimated Gemini API cost for this project — click for a breakdown.\n${project.usage.transcribeCalls} transcription call(s), ${project.usage.promptCalls} prompt draft(s), ${project.usage.imagesGenerated} image(s) generated.`}
            >
              ~{fmtIDR(project.usage.costUSD)}
            </button>
          )}
        <div className="history-controls">
          <button
            className="btn icon"
            onClick={undo}
            disabled={!canUndo}
            title={`Undo (${mod('Z')})`}
            aria-label="Undo"
          >
            <ArrowCounterClockwise size={17} weight="bold" />
          </button>
          <button
            className="btn icon"
            onClick={redo}
            disabled={!canRedo}
            title={`Redo (${mod('⇧Z')})`}
            aria-label="Redo"
          >
            <ArrowClockwise size={17} weight="bold" />
          </button>
        </div>
        {project.transcribed && project.scenes.length > 0 && (
          <button className="btn primary" onClick={() => setExportOpen(true)}>
            <DownloadSimple size={15} weight="bold" /> Export MP4
          </button>
        )}
        <button
          className="btn ghost"
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={17} />
        </button>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <button className="btn ghost" onClick={backToLibrary} title="Back to your projects">
          My Projects
        </button>
      </div>
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </header>
  );
}
