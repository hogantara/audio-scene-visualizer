import { useEffect } from 'react';
import { useStore } from './store';
import { isUndoShortcut, isRedoShortcut, isSaveShortcut } from './lib/keyboard';
import UploadScreen from './components/UploadScreen';
import TranscribeScreen from './components/TranscribeScreen';
import Workspace from './components/Workspace';
import TopBar from './components/TopBar';
import SettingsModal from './components/SettingsModal';
import ExportModal from './components/ExportModal';

export default function App() {
  const phase = useStore((s) => s.phase);
  const project = useStore((s) => s.project);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const exportOpen = useStore((s) => s.exportOpen);
  const toastMsg = useStore((s) => s.toastMsg);
  const init = useStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  // App-wide shortcuts: undo/redo/save always take effect, even while a text field is focused —
  // matching how apps like Figma or Google Docs capture Cmd/Ctrl+Z globally rather than deferring
  // to each field's native undo, which would fight with these React-controlled inputs anyway.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isUndoShortcut(e)) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (isRedoShortcut(e)) {
        e.preventDefault();
        useStore.getState().redo();
      } else if (isSaveShortcut(e)) {
        e.preventDefault();
        useStore.getState().saveNow();
      } else if (e.key === 'Escape') {
        const st = useStore.getState();
        if (st.settingsOpen) st.setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (phase === 'loading') {
    return <div className="center-screen muted">Loading…</div>;
  }

  return (
    <div className="app">
      {phase === 'ready' && project && <TopBar />}
      {phase === 'empty' && <UploadScreen />}
      {phase === 'ready' && project && !project.transcribed && <TranscribeScreen />}
      {phase === 'ready' && project && project.transcribed && <Workspace />}
      {settingsOpen && <SettingsModal />}
      {exportOpen && project && project.transcribed && <ExportModal />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
