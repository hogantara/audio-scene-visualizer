import { useStore } from '../store';
import SceneList from './SceneList';
import SceneEditor from './SceneEditor';
import Player from './Player';

export default function Workspace() {
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  return (
    <div className="workspace">
      <aside className="left-pane">
        <SceneList />
      </aside>
      <main className="right-pane">
        <Player />
        {selectedSceneId ? (
          <SceneEditor key={selectedSceneId} sceneId={selectedSceneId} />
        ) : (
          <div className="editor-empty muted">Select a scene from the list to start editing.</div>
        )}
      </main>
    </div>
  );
}
