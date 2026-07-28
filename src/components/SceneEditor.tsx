import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Clock,
  Scissors,
  ArrowLineDown,
  Sparkle,
  ArrowsClockwise,
  MagicWand,
  UploadSimple,
  Copy,
  CaretLeft,
  CaretRight,
  ArrowCounterClockwise,
  Check,
  WarningCircle,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import { fmtTime, fmtDur } from '../lib/format';
import { buildWordLines, WordSpec } from '../lib/caption';
import { sceneWords } from '../lib/scenes';
import { isEditableTarget } from '../lib/keyboard';

/** Audio auditioned around a word being re-timed: a little lead-in, then the word and its tail. */
const LOOP_LEAD = 0.7;
const LOOP_TAIL = 0.9;
/** One arrow-key nudge. Fine enough to beat the ear, coarse enough to converge in a few taps. */
const NUDGE_STEP = 0.02;

export default function SceneEditor({ sceneId }: { sceneId: string }) {
  const project = useStore((s) => s.project)!;
  const imageUrls = useStore((s) => s.imageUrls);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const updateSceneText = useStore((s) => s.updateSceneText);
  const updateScenePrompt = useStore((s) => s.updateScenePrompt);
  const mergeSceneWithNext = useStore((s) => s.mergeSceneWithNext);
  const splitSceneAt = useStore((s) => s.splitSceneAt);
  const generateSceneImage = useStore((s) => s.generateSceneImage);
  const draftScenePrompt = useStore((s) => s.draftScenePrompt);
  const uploadSceneImage = useStore((s) => s.uploadSceneImage);
  const reuseSceneImage = useStore((s) => s.reuseSceneImage);
  const requestSeek = useStore((s) => s.requestSeek);
  const nudgeWord = useStore((s) => s.nudgeWord);
  const resetWordOffset = useStore((s) => s.resetWordOffset);
  const nudgeSceneWord = useStore((s) => s.nudgeSceneWord);
  const resetSceneWordOffset = useStore((s) => s.resetSceneWordOffset);
  const setLoopRegion = useStore((s) => s.setLoopRegion);

  const [splitMode, setSplitMode] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [reuseMode, setReuseMode] = useState(false);
  const [timingMode, setTimingMode] = useState(false);
  /** Index (into `timedWords`) of the displayed word currently being auditioned, if any. */
  const [timingRel, setTimingRel] = useState<number | null>(null);
  /** In-progress text of the offset field while the user is typing, or null when not editing. */
  const [nudgeDraft, setNudgeDraft] = useState<string | null>(null);
  /** Set by Escape so the blur that follows discards the draft instead of committing it. */
  const cancelNudgeEditRef = useRef(false);
  /** When the offset field last gained focus — lets the focusing click select-all (see onMouseUp). */
  const nudgeFocusAtRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const idx = project.scenes.findIndex((s) => s.id === sceneId);
  const scene = project.scenes[idx];

  /**
   * The DISPLAYED words (parsed from the editable text) with their resolved karaoke times — the
   * same list the preview highlights, so the timing chips always match what's on screen: edited
   * words show their edited form, deleted words disappear, added words appear (with interpolated
   * timing, srcIndex === -1).
   */
  const timedWords = useMemo(
    () =>
      scene
        ? buildWordLines(
            scene.text,
            sceneWords(project, scene),
            scene.start,
            scene.end,
            project.sceneWordOffsets?.[scene.id]
          ).flat()
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene?.id, scene?.text, scene?.start, scene?.end, project.words, project.wordOffsets, project.sceneWordOffsets]
  );
  const timingWord = timingRel !== null ? timedWords[timingRel] : undefined;

  const stopTiming = () => {
    setTimingRel(null);
    setLoopRegion(null);
  };

  // A half-typed offset belongs to the word it was typed for — drop it when the word changes.
  useEffect(() => setNudgeDraft(null), [timingRel]);

  /** The word's stored correction: transcript-matched words in wordOffsets, added words per scene. */
  const offsetFor = (w: WordSpec) =>
    w.srcIndex >= 0
      ? project.wordOffsets[scene.wordStart + w.srcIndex] ?? 0
      : project.sceneWordOffsets?.[scene.id]?.[w.key] ?? 0;

  /** Nudge whichever word is being auditioned, routing to the store slot that owns its timing. */
  const nudgeTimingWord = (delta: number) => {
    if (!scene || !timingWord) return;
    if (timingWord.srcIndex >= 0) nudgeWord(scene.wordStart + timingWord.srcIndex, delta);
    else nudgeSceneWord(scene.id, timingWord.key, delta, { s: timingWord.baseStart, e: timingWord.baseEnd });
  };

  /**
   * The audio window to loop while auditioning a word. Its resolved [start, end] already carries
   * any nudge, so the window spans a lead-in ahead of wherever the word now sits to a tail past
   * it — however far the word is nudged you always hear it play within the loop.
   */
  const loopRegionFor = (w: { start: number; end: number }) => ({
    from: Math.max(0, w.start - LOOP_LEAD),
    to: Math.min(project.duration, w.end + LOOP_TAIL),
  });

  /**
   * Audition one word: loop a window of audio around where the word currently sits, judging the
   * repeating phrase rather than tapping along in real time (which would add ~200 ms reaction lag).
   * The window tracks the nudge (see the effect below), so the word never falls outside the loop.
   */
  const startTiming = (rel: number) => {
    const w = timedWords[rel];
    if (!w) return;
    const region = loopRegionFor(w);
    setTimingRel(rel);
    setLoopRegion(region);
    requestSeek(region.from, { play: true });
  };

  // Arrows nudge the word being auditioned; Esc leaves. The Player yields its own arrow bindings
  // (prev/next scene) whenever a loop is active, so the two never both fire. Re-bound whenever the
  // words recompute so the handler always nudges from the word's current resolved span.
  useEffect(() => {
    if (timingRel === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        nudgeTimingWord(e.key === 'ArrowLeft' ? -NUDGE_STEP : NUDGE_STEP);
      } else if (e.key === 'Escape') {
        stopTiming();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timingRel, timedWords]);

  // Keep the audition loop centred on the word as it's nudged, so pushing it far still plays it back.
  useEffect(() => {
    if (timingRel === null) return;
    const w = timedWords[timingRel];
    if (!w) return;
    setLoopRegion(loopRegionFor(w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timingRel, timingWord?.start, timingWord?.end]);

  // Never leave the player looping after this editor goes away or switches scene.
  useEffect(() => () => setLoopRegion(null), [sceneId, setLoopRegion]);

  // Restore the selection right after React commits the new text. A layout effect (unlike
  // requestAnimationFrame) is guaranteed to run synchronously after the DOM update, so it can't
  // race the browser's own "reset selection to the end" behavior when a controlled value changes —
  // that race was why repeated clicks fell back to appending at the end instead of toggling.
  useLayoutEffect(() => {
    const sel = pendingSelectionRef.current;
    if (sel && textRef.current) {
      textRef.current.setSelectionRange(sel.start, sel.end);
      pendingSelectionRef.current = null;
    }
  }, [scene?.text]);

  if (!scene) return null;

  const words = project.words.slice(scene.wordStart, scene.wordEnd);
  const nudgeVal = timingWord ? offsetFor(timingWord) : 0;

  /**
   * Apply a hand-typed offset (seconds; negative = earlier). Routed through nudgeTimingWord as a
   * delta from the current offset, so both timing stores and their audio-bounds clamping are reused.
   */
  const commitNudgeDraft = () => {
    const draft = nudgeDraft;
    setNudgeDraft(null);
    if (draft === null) return;
    const v = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    const delta = Number(v.toFixed(3)) - nudgeVal;
    if (Math.abs(delta) >= 1e-4) nudgeTimingWord(delta);
  };
  const imageUrl = scene.imageId ? imageUrls[scene.imageId] : null;
  const generating = scene.imageStatus === 'generating';

  // Other scenes' images, deduped by imageId, excluding whatever this scene already shows.
  const reusable: { imageId: string; label: string; url: string }[] = [];
  const seenImageIds = new Set<string>();
  project.scenes.forEach((s, i) => {
    if (s.id === scene.id || !s.imageId || s.imageId === scene.imageId) return;
    if (seenImageIds.has(s.imageId)) return;
    const url = imageUrls[s.imageId];
    if (!url) return;
    seenImageIds.add(s.imageId);
    reusable.push({ imageId: s.imageId, label: `Scene ${i + 1}`, url });
  });

  /**
   * Toggle a markdown marker around the current selection: if the selection is already
   * immediately surrounded by the marker, strip it (turn the formatting off); otherwise add it.
   * Without this check, clicking the same (or another) formatter repeatedly nests marker after
   * marker instead of switching the formatting on and off.
   */
  const wrap = (marker: string, placeholder: string) => {
    const ta = textRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = scene.text;
    const hasSelection = start !== end;
    const alreadyWrapped =
      hasSelection &&
      value.slice(start - marker.length, start) === marker &&
      value.slice(end, end + marker.length) === marker;

    let next: string;
    let selStart: number;
    let selEnd: number;

    if (alreadyWrapped) {
      // Strip the surrounding marker.
      next = value.slice(0, start - marker.length) + value.slice(start, end) + value.slice(end + marker.length);
      selStart = start - marker.length;
      selEnd = end - marker.length;
    } else {
      const selected = hasSelection ? value.slice(start, end) : placeholder;
      next = value.slice(0, start) + marker + selected + marker + value.slice(end);
      selStart = start + marker.length;
      selEnd = selStart + selected.length;
    }

    ta.focus();
    pendingSelectionRef.current = { start: selStart, end: selEnd };
    updateSceneText(scene.id, next);
    // Text may be unchanged from a prior render in edge cases (e.g. empty marker), so the layout
    // effect's dependency wouldn't fire — apply the selection synchronously too as a fallback.
    if (scene.text === next) {
      ta.setSelectionRange(selStart, selEnd);
      pendingSelectionRef.current = null;
    }
  };

  return (
    <section className="scene-editor">
      <div className="editor-header">
        <div>
          <strong>Scene {idx + 1}</strong>{' '}
          <span className="muted">
            {fmtTime(scene.start)} – {fmtTime(scene.end)} · {fmtDur(scene.end - scene.start)}
          </span>
          {scene.estimatedBounds && (
            <div
              className="review-badge"
              title="This beat's narration wasn't found in the transcript, so its cut points came from the storyboard's estimated timecodes. Check them against the waveform."
            >
              <WarningCircle size={12} weight="fill" /> Timing estimated — check the waveform
            </div>
          )}
        </div>
        <div className="row gap editor-actions">
          <button
            className="btn small-btn"
            onClick={() => {
              stopTiming(); // otherwise the word loop would drag playback straight back.
              requestSeek(scene.start, { play: true, stopAt: scene.end });
            }}
            title="Play just this scene"
          >
            <Play size={13} weight="fill" /> Preview scene
          </button>
          <div className="mode-toggle-group">
            <button
              className={`btn small-btn ${timingMode ? 'primary' : ''}`}
              disabled={timedWords.length === 0 || project.captionStyle === 'static'}
              title={
                project.captionStyle === 'static'
                  ? 'Word timing only applies to the highlight and word-by-word styles'
                  : 'Fix a word that highlights at the wrong moment'
              }
              onClick={() => {
                if (timingMode) stopTiming();
                setTimingMode(!timingMode);
                setSplitMode(false);
              }}
            >
              <Clock size={13} /> Fix timing
            </button>
            <button
              className={`btn small-btn ${splitMode ? 'primary' : ''}`}
              disabled={words.length < 2}
              onClick={() => {
                setSplitMode(!splitMode);
                stopTiming();
                setTimingMode(false);
              }}
            >
              <Scissors size={13} /> Split
            </button>
          </div>
          <button
            className="btn small-btn ghost editor-actions-spacer"
            disabled={idx >= project.scenes.length - 1}
            onClick={() => mergeSceneWithNext(scene.id)}
            title="Merge this scene with the next one"
          >
            <ArrowLineDown size={13} /> Merge with next
          </button>
        </div>
      </div>

      {splitMode ? (
        <div className="split-box">
          <p className="muted small">Click the word that should start the new scene. (Both halves keep their word timing; text is re-taken from the transcript.)</p>
          <div className="word-chips">
            {words.map((w, i) => (
              <button
                key={i}
                className="chip"
                disabled={i === 0}
                onClick={() => {
                  splitSceneAt(scene.id, i);
                  setSplitMode(false);
                }}
              >
                {w.w}
              </button>
            ))}
          </div>
        </div>
      ) : timingMode ? (
        <div className="split-box">
          <p className="muted small">
            Click the word that highlights at the wrong moment — its audio loops so you can hear it.
            Then nudge with ← / → until the highlight lands on the beat. Dotted words are ones you've
            already adjusted; dashed italic words aren't in the transcript (added or reworded), so
            their timing is estimated — you can still nudge them.
          </p>
          <div className="word-chips">
            {timedWords.map((w, i) => {
              const off = offsetFor(w);
              const est = w.srcIndex < 0;
              return (
                <button
                  key={i}
                  className={`chip ${timingRel === i ? 'chip-timing' : ''} ${off ? 'chip-tuned' : ''} ${est ? 'chip-est' : ''}`}
                  onClick={() => (timingRel === i ? stopTiming() : startTiming(i))}
                  title={
                    off
                      ? `Adjusted by ${off > 0 ? '+' : ''}${off.toFixed(2)}s`
                      : est
                        ? 'Not in the transcript — timing estimated from its neighbours. Click to hear it'
                        : 'Click to hear this word'
                  }
                >
                  {w.text}
                </button>
              );
            })}
          </div>
          {timingWord && (
            <div className="nudge-bar">
              <strong className="nudge-word">“{timingWord.text}”</strong>
              <button
                className="btn small-btn"
                onClick={() => nudgeTimingWord(-NUDGE_STEP)}
                title="Highlight this word earlier (←)"
              >
                <CaretLeft size={13} /> Earlier
              </button>
              <span className={`nudge-val ${nudgeVal ? 'tuned' : ''}`}>
                <input
                  className="nudge-input"
                  type="text"
                  inputMode="decimal"
                  value={nudgeDraft ?? (nudgeVal ? `${nudgeVal > 0 ? '+' : ''}${nudgeVal.toFixed(2)}` : '0')}
                  onFocus={(e) => {
                    setNudgeDraft(nudgeVal ? nudgeVal.toFixed(2) : '0');
                    nudgeFocusAtRef.current = performance.now();
                    // Select-all so typing replaces the value. Deferred, as the focus-time DOM is
                    // about to be re-rendered; covers keyboard focus — click focus is finished off
                    // in onMouseUp, since a click's mouseup would collapse this selection again.
                    const el = e.currentTarget;
                    requestAnimationFrame(() => el.select());
                  }}
                  onMouseUp={(e) => {
                    // The mouseup ending the click that focused the field would collapse the
                    // select-all into a caret; keep the selection for that first click only.
                    if (performance.now() - nudgeFocusAtRef.current < 400) {
                      e.preventDefault();
                      e.currentTarget.select();
                    }
                  }}
                  onChange={(e) => setNudgeDraft(e.target.value)}
                  onBlur={() => {
                    if (cancelNudgeEditRef.current) {
                      cancelNudgeEditRef.current = false;
                      setNudgeDraft(null);
                      return;
                    }
                    commitNudgeDraft();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur(); // blur commits
                    } else if (e.key === 'Escape') {
                      cancelNudgeEditRef.current = true;
                      e.currentTarget.blur();
                    }
                  }}
                  title="Type an offset in seconds and press Enter — negative plays the highlight earlier, positive later. 0 restores the automatic time"
                  aria-label="Timing offset in seconds"
                />
                s
              </span>
              <button
                className="btn small-btn"
                onClick={() => nudgeTimingWord(NUDGE_STEP)}
                title="Highlight this word later (→)"
              >
                Later <CaretRight size={13} />
              </button>
              <button
                className="btn small-btn"
                disabled={!nudgeVal}
                onClick={() =>
                  timingWord.srcIndex >= 0
                    ? resetWordOffset(scene.wordStart + timingWord.srcIndex)
                    : resetSceneWordOffset(scene.id, timingWord.key)
                }
                title={
                  timingWord.srcIndex >= 0
                    ? 'Put this word back on its transcribed time'
                    : 'Put this word back on its estimated time'
                }
              >
                <ArrowCounterClockwise size={13} /> Reset
              </button>
              <button className="btn small-btn" onClick={stopTiming} title="Stop looping (Esc)">
                <Check size={13} weight="bold" /> Done
              </button>
            </div>
          )}
        </div>
      ) : (
        <label className="field">
          <span>
            On-screen text <span className="muted">— shown exactly as written; edits never change audio timing</span>
          </span>
          <div className="format-toolbar">
            <button type="button" className="fmt-btn" title="Bold (**text**)" onClick={() => wrap('**', 'bold')}>
              <b>B</b>
            </button>
            <button type="button" className="fmt-btn" title="Italic (*text*)" onClick={() => wrap('*', 'italic')}>
              <i>I</i>
            </button>
            <button type="button" className="fmt-btn" title="Highlight (==text==)" onClick={() => wrap('==', 'highlight')}>
              <span className="fmt-hl">H</span>
            </button>
            <span className="muted small">
              Line breaks and markdown (**bold**, *italic*, ==highlight==) render in the preview.
            </span>
          </div>
          <textarea
            ref={textRef}
            rows={4}
            value={scene.text}
            onChange={(e) => updateSceneText(scene.id, e.target.value)}
          />
        </label>
      )}

      <div className="image-row">
        <div className="image-preview">
          {imageUrl ? (
            <img src={imageUrl} alt={`Scene ${idx + 1} illustration`} />
          ) : (
            <div className={`image-placeholder ph-${idx % 5}`}>
              {generating ? <div className="spinner" /> : <span>No image yet</span>}
            </div>
          )}
          {generating && imageUrl && (
            <div className="image-overlay">
              <div className="spinner" />
            </div>
          )}
        </div>

        <div className="image-controls">
          <label className="field">
            <span>Image prompt</span>
            <textarea
              rows={4}
              value={scene.prompt}
              onChange={(e) => updateScenePrompt(scene.id, e.target.value)}
            />
          </label>
          {project.style.trim() && (
            <div className="muted small">+ project style: “{project.style.trim()}”</div>
          )}
          {scene.imageError && <div className="error-box small">{scene.imageError}</div>}
          <div className="row gap wrap">
            <button className="btn primary" disabled={generating} onClick={() => generateSceneImage(scene.id)}>
              {generating ? (
                'Generating…'
              ) : scene.imageId ? (
                <>
                  <ArrowsClockwise size={14} /> Regenerate
                </>
              ) : (
                <>
                  <Sparkle size={14} weight="fill" /> Generate image
                </>
              )}
            </button>
            <button
              className="btn"
              disabled={drafting}
              title="Let AI rewrite the prompt from this scene's text"
              onClick={async () => {
                setDrafting(true);
                await draftScenePrompt(scene.id);
                setDrafting(false);
              }}
            >
              {drafting ? (
                'Drafting…'
              ) : (
                <>
                  <MagicWand size={14} /> Draft prompt with AI
                </>
              )}
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              <UploadSimple size={14} /> Use my own image
            </button>
            <button
              className={`btn ${reuseMode ? 'primary' : ''}`}
              disabled={reusable.length === 0}
              title={reusable.length === 0 ? 'No other scene has an image yet' : 'Reuse an image from another scene'}
              onClick={() => setReuseMode(!reuseMode)}
            >
              <Copy size={14} /> Reuse image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadSceneImage(scene.id, f);
                e.target.value = '';
              }}
            />
          </div>
          {reuseMode && (
            <div className="split-box">
              <p className="muted small">Pick a scene to reuse its image here. The same image can be used in multiple scenes.</p>
              <div className="reuse-grid">
                {reusable.map((r) => (
                  <button
                    key={r.imageId}
                    className="reuse-thumb"
                    title={r.label}
                    onClick={() => {
                      reuseSceneImage(scene.id, r.imageId);
                      setReuseMode(false);
                    }}
                  >
                    <img src={r.url} alt={r.label} />
                    <span>{r.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
