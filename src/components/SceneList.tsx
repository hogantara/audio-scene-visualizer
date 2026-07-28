import { useState } from 'react';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  Circle,
  Sparkle,
  Pause,
  FileText,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import StoryboardModal from './StoryboardModal';
import { fmtTime, fmtDur } from '../lib/format';
import { FONTS } from '../lib/fonts';
import { stripMarkup } from '../lib/caption';
import type { Project, Scene } from '../types';

function statusDot(s: Scene): { cls: string; label: string; icon: JSX.Element } {
  switch (s.imageStatus) {
    case 'ready':
      return { cls: 'ok', label: 'Image ready', icon: <CheckCircle size={13} weight="fill" /> };
    case 'generating':
      return { cls: 'busy', label: 'Generating…', icon: <CircleNotch size={13} weight="bold" className="spin" /> };
    case 'error':
      return { cls: 'err', label: 'Generation failed', icon: <WarningCircle size={13} weight="fill" /> };
    default:
      return { cls: 'none', label: 'No image yet', icon: <Circle size={13} /> };
  }
}

export default function SceneList() {
  const project = useStore((s) => s.project)!;
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const activeSceneId = useStore((s) => s.activeSceneId);
  const imageUrls = useStore((s) => s.imageUrls);
  const selectScene = useStore((s) => s.selectScene);
  const requestSeek = useStore((s) => s.requestSeek);
  const setStyle = useStore((s) => s.setStyle);
  const setCaptionFont = useStore((s) => s.setCaptionFont);
  const setHighlightColor = useStore((s) => s.setHighlightColor);
  const setBgBrightness = useStore((s) => s.setBgBrightness);
  const setCaptionScale = useStore((s) => s.setCaptionScale);
  const setCaptionStyle = useStore((s) => s.setCaptionStyle);
  const setCaptionEntrance = useStore((s) => s.setCaptionEntrance);
  const generateAllMissing = useStore((s) => s.generateAllMissing);
  const stopQueue = useStore((s) => s.stopQueue);
  const queueActive = useStore((s) => s.queueActive);

  const missing = project.scenes.filter((s) => s.imageStatus !== 'ready').length;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storyboardOpen, setStoryboardOpen] = useState(false);

  return (
    <div className="scene-list-wrap">
      <div className="scene-list-header">
        <div className="row space-between">
          <strong>
            Scenes <span className="muted">({project.scenes.length})</span>
          </strong>
          {queueActive ? (
            <button className="btn small-btn" onClick={stopQueue}>
              <Pause size={13} weight="fill" /> Stop ({missing} left)
            </button>
          ) : (
            missing > 0 && (
              <button className="btn small-btn primary" onClick={generateAllMissing}>
                <Sparkle size={13} weight="fill" /> Generate all ({missing})
              </button>
            )
          )}
        </div>

        <div className="row space-between">
          <button
            type="button"
            className="settings-toggle"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
          >
            {settingsOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}
            Style &amp; subtitles
          </button>
          <button
            className="btn ghost small-btn"
            onClick={() => setStoryboardOpen(true)}
            title="Rebuild these scenes from a markdown storyboard"
          >
            <FileText size={13} weight="regular" /> Storyboard
          </button>
        </div>

        {settingsOpen && (
          <div className="settings-panel">
            <input
              className="style-input"
              placeholder="Image style for the whole project — e.g. “flat pastel illustration, soft light”"
              value={project.style}
              onChange={(e) => setStyle(e.target.value)}
              title="Appended to every scene's image prompt"
            />
            <label className="font-row">
              <span className="muted small">Subtitle font</span>
              <select
                className="font-select"
                value={project.captionFont}
                onChange={(e) => setCaptionFont(e.target.value)}
              >
                {FONTS.map((f) => (
                  <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="font-row">
              <span className="muted small">Highlight color</span>
              <input
                type="color"
                className="color-input"
                value={project.highlightColor}
                onChange={(e) => setHighlightColor(e.target.value)}
                title="Marker color for ==highlighted== text"
              />
            </label>
            <label className="font-row">
              <span className="muted small">Background brightness</span>
              <div className="brightness-control">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={project.bgBrightness}
                  onChange={(e) => setBgBrightness(Number(e.target.value))}
                  title="Dim the background so the subtitle stays readable"
                />
                <span className="muted small pct">{Math.round(project.bgBrightness * 100)}%</span>
              </div>
            </label>
            <label className="font-row">
              <span className="muted small">Subtitle size</span>
              <div className="brightness-control">
                <input
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={project.captionScale}
                  onChange={(e) => setCaptionScale(Number(e.target.value))}
                  title="Adjust the subtitle's size in the preview"
                />
                <span className="muted small pct">{Math.round(project.captionScale * 100)}%</span>
              </div>
            </label>
            <label className="font-row">
              <span className="muted small">Caption style</span>
              <select
                className="font-select"
                value={project.captionStyle}
                onChange={(e) => setCaptionStyle(e.target.value as Project['captionStyle'])}
                title="How the subtitle animates as the audio plays"
              >
                <option value="highlight">Highlight (karaoke sweep)</option>
                <option value="word">Word by word</option>
                <option value="static">Static (show all)</option>
              </select>
            </label>
            {project.captionStyle === 'word' && (
              <label className="font-row">
                <span className="muted small">Word entrance</span>
                <select
                  className="font-select"
                  value={project.captionEntrance}
                  onChange={(e) => setCaptionEntrance(e.target.value as Project['captionEntrance'])}
                  title="How each word animates in as it's spoken"
                >
                  <option value="fade">Fade in</option>
                  <option value="none">Instant (no animation)</option>
                </select>
              </label>
            )}
            {project.captionStyle !== 'static' && (
              <p className="muted small hint-row">
                A word appearing at the wrong moment? Select its scene and use Fix timing.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="scene-list">
        {project.scenes.map((scene, i) => {
          const dot = statusDot(scene);
          const url = scene.imageId ? imageUrls[scene.imageId] : null;
          return (
            <div
              key={scene.id}
              className={`scene-card ${selectedSceneId === scene.id ? 'selected' : ''} ${
                activeSceneId === scene.id ? 'playing' : ''
              }`}
              onClick={() => {
                selectScene(scene.id);
                requestSeek(scene.start);
              }}
            >
              <div className="scene-thumb">
                {url ? (
                  <img src={url} alt="" />
                ) : scene.imageStatus === 'generating' ? (
                  <div className="spinner small" />
                ) : (
                  <span className="thumb-num">{i + 1}</span>
                )}
              </div>
              <div className="scene-card-body">
                <div className="scene-card-meta muted">
                  <span>#{i + 1}</span>
                  <span>{fmtTime(scene.start)}</span>
                  <span>{fmtDur(scene.end - scene.start)}</span>
                  <span className={`dot ${dot.cls}`} title={dot.label} aria-label={dot.label}>
                    {dot.icon}
                  </span>
                </div>
                <div className="scene-card-text">{stripMarkup(scene.text)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {storyboardOpen && <StoryboardModal onClose={() => setStoryboardOpen(false)} />}
    </div>
  );
}
