import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fmtTime } from '../lib/format';
import { font } from '../lib/fonts';
import {
  buildWordLines,
  layoutCaption,
  makeMeasure,
  drawCaptionLayout,
  drawScrim,
  CaptionLayout,
  MAX_FONT_FRACTION,
  MIN_FONT_FRACTION,
  CAPTION_MAX_WIDTH,
  CAPTION_MAX_HEIGHT,
  LINE_HEIGHT_FACTOR,
} from '../lib/caption';
import { sceneWords } from '../lib/scenes';
import { computeSceneMix, edgeFadeAlpha, smoothstep, TRANSITION_SEC } from '../lib/transition';
import { isEditableTarget } from '../lib/keyboard';
import type { CaptionPos, Scene } from '../types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function Player() {
  const project = useStore((s) => s.project)!;
  const audioUrl = useStore((s) => s.audioUrl);
  const imageUrls = useStore((s) => s.imageUrls);
  const seekRequest = useStore((s) => s.seekRequest);
  const loopRegion = useStore((s) => s.loopRegion);
  const setLoopRegion = useStore((s) => s.setLoopRegion);
  const setActiveScene = useStore((s) => s.setActiveScene);
  const selectScene = useStore((s) => s.selectScene);
  const setCaptionPos = useStore((s) => s.setCaptionPos);

  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const captionCanvasRef = useRef<HTMLCanvasElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const dragRef = useRef<{ offx: number; offy: number; downX: number; downY: number } | null>(null);
  const didDragRef = useRef(false);
  const timeRef = useRef(0);
  const layoutRef = useRef<CaptionLayout | null>(null);
  const posRef = useRef<CaptionPos>(project.captionPos);
  const stageSizeRef = useRef({ w: 0, h: 0 });

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragPos, setDragPos] = useState<CaptionPos | null>(null);
  const [bbox, setBbox] = useState<{ w: number; h: number } | null>(null);

  const { scenes, duration } = project;
  let sceneIdx = scenes.findIndex((s) => time < s.end);
  if (sceneIdx === -1) sceneIdx = scenes.length - 1;
  const scene = scenes[sceneIdx] as Scene | undefined;

  const f = font(project.captionFont);
  const pos = dragPos ?? project.captionPos;
  posRef.current = pos;

  const mix = useMemo(
    () => computeSceneMix(scenes, time, sceneIdx, TRANSITION_SEC),
    [scenes, time, sceneIdx]
  );
  const mixEased = smoothstep(mix.mix);
  const edgeFade = edgeFadeAlpha(scenes, time, duration, TRANSITION_SEC);

  const wordLines = useMemo(
    () =>
      scene
        ? buildWordLines(
            scene.text,
            sceneWords(project, scene),
            scene.start,
            scene.end,
            project.sceneWordOffsets?.[scene.id]
          )
        : [],
    [scene?.id, scene?.text, scene?.start, scene?.end, project.words, project.wordOffsets, project.sceneWordOffsets]
  );
  const measure = useMemo(() => makeMeasure(f.family, f.weight, f.bold), [f.family, f.weight, f.bold]);

  const drawCaption = useCallback(() => {
    const cv = captionCanvasRef.current;
    const layout = layoutRef.current;
    if (!cv) return;
    const { w: W, h: H } = stageSizeRef.current;
    const ctx = cv.getContext('2d');
    if (!ctx || W === 0) return;
    ctx.clearRect(0, 0, W, H);
    drawScrim(ctx, W, H, project.bgBrightness);
    if (!layout) return;
    drawCaptionLayout(ctx, {
      layout,
      t: timeRef.current,
      W,
      H,
      posX: posRef.current.x,
      posY: posRef.current.y,
      family: f.family,
      weightNormal: f.weight,
      weightBold: f.bold,
      highlightColor: project.highlightColor,
      style: project.captionStyle,
      entrance: project.captionEntrance,
    });
  }, [
    f.family,
    f.weight,
    f.bold,
    project.highlightColor,
    project.bgBrightness,
    project.captionStyle,
    project.captionEntrance,
  ]);

  // Recompute layout when the text, font, highlight, or stage size changes.
  const relayout = useCallback(() => {
    const stage = stageRef.current;
    const cv = captionCanvasRef.current;
    if (!stage || !cv) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    stageSizeRef.current = { w: W, h: H };
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (wordLines.length === 0) {
      layoutRef.current = null;
      setBbox(null);
      drawCaption();
      return;
    }
    const scale = project.captionScale;
    const layout = layoutCaption(wordLines, {
      measure,
      maxWidth: W * CAPTION_MAX_WIDTH,
      maxHeight: H * CAPTION_MAX_HEIGHT,
      maxFontPx: W * MAX_FONT_FRACTION * scale,
      minFontPx: W * MIN_FONT_FRACTION * scale,
      lineHeightFactor: LINE_HEIGHT_FACTOR,
    });
    layoutRef.current = layout;
    setBbox(W > 0 ? { w: layout.blockWidth / W, h: layout.blockHeight / H } : null);
    drawCaption();
  }, [wordLines, measure, drawCaption, project.captionScale]);

  useEffect(() => {
    relayout();
  }, [relayout]);

  // Redraw on stage resize.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => relayout());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [relayout]);

  // Redraw when paused and position/time changes (playback redraws happen in the rAF loop).
  useEffect(() => {
    if (!playing) drawCaption();
  }, [drawCaption, pos.x, pos.y, time, playing]);

  // Consume seek requests from the scene list / editor.
  useEffect(() => {
    if (!seekRequest || !audioRef.current) return;
    const a = audioRef.current;
    a.currentTime = Math.min(seekRequest.t, duration - 0.01);
    stopAtRef.current = seekRequest.stopAt ?? null;
    timeRef.current = a.currentTime;
    setTime(a.currentTime);
    if (seekRequest.play) a.play();
  }, [seekRequest, duration]);

  // Loop state is read through a ref so toggling a loop doesn't tear down the rAF loop mid-playback.
  const loopRef = useRef(loopRegion);
  loopRef.current = loopRegion;

  // Drive the clock + caption redraw off requestAnimationFrame for smooth sync.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        const loop = loopRef.current;
        // Loop takes precedence over stopAt: auditioning one word should repeat, not halt.
        if (loop && a.currentTime >= loop.to) a.currentTime = loop.from;
        timeRef.current = a.currentTime;
        setTime(a.currentTime);
        drawCaption();
        if (!loop && stopAtRef.current !== null && a.currentTime >= stopAtRef.current) {
          a.pause();
          stopAtRef.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, drawCaption]);

  // Report the scene under the playhead so the list can highlight it.
  useEffect(() => {
    setActiveScene(scene?.id ?? null);
  }, [scene?.id, setActiveScene]);

  // Stable (empty/minimal deps) so the keyboard-shortcut effect below doesn't need to re-attach its
  // listener on every render — reads fresh project state via getState() instead of closing over it.
  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const proj = useStore.getState().project;
    if (a.paused) {
      stopAtRef.current = null;
      if (proj && a.currentTime >= proj.duration - 0.05) a.currentTime = 0;
      a.play();
    } else {
      a.pause();
    }
  }, []);

  const jumpScene = useCallback(
    (dir: -1 | 1) => {
      const a = audioRef.current;
      const proj = useStore.getState().project;
      if (!a || !proj || proj.scenes.length === 0) return;
      let idx = proj.scenes.findIndex((s) => a.currentTime < s.end);
      if (idx === -1) idx = proj.scenes.length - 1;
      const target = proj.scenes[Math.min(proj.scenes.length - 1, Math.max(0, idx + dir))];
      if (!target) return;
      stopAtRef.current = null;
      a.currentTime = target.start;
      timeRef.current = target.start;
      setTime(target.start);
      selectScene(target.id);
    },
    [selectScene]
  );

  // Space to play/pause, arrows to jump scenes — skipped while typing, or while a modal has focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const st = useStore.getState();
      if (st.settingsOpen || st.exportOpen) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
      }
      // While a word is being auditioned, the arrows belong to its nudge control, not scene jumps.
      if (st.loopRegion) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        jumpScene(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        jumpScene(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePlay, jumpScene]);

  // ---- Subtitle drag ----
  // The hitbox sits on top of the whole stage (including the play button) so the caption can be
  // grabbed anywhere. A plain click must still reach the stage's play/pause toggle underneath;
  // only an actual drag (pointer moved past a small threshold) should be swallowed, both so the
  // reposition doesn't also toggle playback and so a simple click on/near the caption still works
  // as a play/pause click.
  const DRAG_THRESHOLD = 4;

  const onCaptionDown = (e: React.PointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + pos.x * rect.width;
    const cy = rect.top + pos.y * rect.height;
    dragRef.current = { offx: e.clientX - cx, offy: e.clientY - cy, downX: e.clientX, downY: e.clientY };
    didDragRef.current = false;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCaptionMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!didDragRef.current) {
      const moved = Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY);
      if (moved < DRAG_THRESHOLD) return;
      didDragRef.current = true;
      setDragPos(pos);
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = {
      x: clamp((e.clientX - drag.offx - rect.left) / rect.width, 0.05, 0.95),
      y: clamp((e.clientY - drag.offy - rect.top) / rect.height, 0.06, 0.94),
    };
    posRef.current = next;
    setDragPos(next);
    drawCaption();
  };
  const onCaptionUp = () => {
    dragRef.current = null;
    if (didDragRef.current && dragPos) setCaptionPos(dragPos);
    setDragPos(null);
  };
  const onCaptionClick = (e: React.MouseEvent) => {
    // Swallow the click only if it ended a real drag; otherwise let it bubble to toggle play/pause.
    if (didDragRef.current) e.stopPropagation();
    didDragRef.current = false;
  };

  return (
    <div className="player">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}

      <div className="stage" ref={stageRef} onClick={togglePlay}>
        {(() => {
          const layer = (idx: number, opacity: number, showLabel: boolean) => {
            const s = scenes[idx];
            const url = s?.imageId ? imageUrls[s.imageId] : null;
            return (
              <div key={idx} style={{ position: 'absolute', inset: 0, opacity }}>
                {url ? (
                  <img className="stage-image" src={url} alt="" />
                ) : (
                  <div className={`stage-placeholder ph-${idx % 5}`}>
                    {showLabel && s && <span>Scene {idx + 1} — no image yet</span>}
                  </div>
                )}
              </div>
            );
          };
          return (
            <>
              {layer(mix.a, 1, mix.a === sceneIdx)}
              {mix.b !== mix.a && layer(mix.b, mixEased, mix.b === sceneIdx)}
            </>
          );
        })()}
        <canvas ref={captionCanvasRef} className="caption-canvas" />
        {edgeFade > 0 && (
          <div
            className="edge-fade"
            style={{
              position: 'absolute',
              inset: 0,
              background: '#000',
              opacity: edgeFade,
              pointerEvents: 'none',
            }}
          />
        )}
        {!playing && (
          <div className="stage-play-hint">
            <span>▶</span>
          </div>
        )}
        {bbox && (
          <div
            className={`caption-hitbox ${didDragRef.current ? 'dragging' : ''}`}
            style={{
              left: `${pos.x * 100}%`,
              top: `${pos.y * 100}%`,
              width: `${Math.max(bbox.w * 100, 8)}%`,
              height: `${Math.max(bbox.h * 100, 6)}%`,
            }}
            onClick={onCaptionClick}
            onPointerDown={onCaptionDown}
            onPointerMove={onCaptionMove}
            onPointerUp={onCaptionUp}
            title="Click to play/pause, drag to reposition the subtitle"
          />
        )}
      </div>

      <div className="caption-tools">
        <span className="muted small">Drag the subtitle in the preview to reposition it.</span>
        <button
          className="btn small-btn"
          onClick={() => {
            setDragPos(null);
            setCaptionPos({ x: 0.5, y: 0.5 });
          }}
        >
          ⤢ Center subtitle
        </button>
      </div>

      <div className="transport">
        <button className="btn icon" onClick={() => jumpScene(-1)} title="Previous scene">
          ⏮
        </button>
        <button className="btn icon play" onClick={togglePlay} title="Play / pause">
          {playing ? '⏸' : '▶'}
        </button>
        <button className="btn icon" onClick={() => jumpScene(1)} title="Next scene">
          ⏭
        </button>
        <span className="time-label">
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
        <div className="seek-wrap">
          <div className="scene-ticks">
            {scenes.slice(1).map((s) => (
              <span key={s.id} style={{ left: `${(s.start / duration) * 100}%` }} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={Math.min(time, duration)}
            onChange={(e) => {
              const t = Number(e.target.value);
              stopAtRef.current = null;
              // Scrubbing is an explicit "go here" — drop any word-audition loop rather than fight it.
              if (loopRegion) setLoopRegion(null);
              if (audioRef.current) audioRef.current.currentTime = t;
              timeRef.current = t;
              setTime(t);
            }}
          />
        </div>
      </div>
    </div>
  );
}
