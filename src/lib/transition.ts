import type { Scene } from '../types';

/** Crossfade length in seconds. "Slow" and cinematic rather than a quick cut. */
export const TRANSITION_SEC = 1.1;

export interface SceneMix {
  /** Outgoing scene index — drawn first, fully opaque. */
  a: number;
  /** Incoming scene index — drawn on top at `mix` opacity. Equals `a` when no transition is active. */
  b: number;
  /** 0 = fully `a`, 1 = fully `b`. */
  mix: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Ease-in-out curve so the crossfade breathes rather than blending at a flat linear rate. */
export function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Opacity of a black overlay that fades the whole frame in at the very start and out at the very
 * end, so the episode opens from black and closes to black with the same slow, eased feel as a
 * scene-to-scene crossfade. Returns 1 (fully black) at t=0 and t=duration, easing to 0 across a
 * `transitionSec` window — capped to the first/last scene's own length so a very short opening or
 * closing scene never has its fade run past it. 0 anywhere in between.
 */
export function edgeFadeAlpha(scenes: Scene[], t: number, duration: number, transitionSec: number): number {
  if (scenes.length === 0 || duration <= 0) return 0;
  const inWin = Math.min(transitionSec, scenes[0].end - scenes[0].start);
  if (inWin > 0 && t < inWin) return 1 - smoothstep(t / inWin);
  const last = scenes[scenes.length - 1];
  const outWin = Math.min(transitionSec, last.end - last.start);
  if (outWin > 0 && t > duration - outWin) return smoothstep((t - (duration - outWin)) / outWin);
  return 0;
}

/**
 * Determine which scene(s) are on screen at time `t` and how far a crossfade between them has
 * progressed. `currentIdx` is the caller's already-computed "hard cut" scene index (the same one
 * used for caption text), so this only decides whether that cut should currently be softened by a
 * fade into the neighbor on either side. The transition window at a boundary is capped at half of
 * whichever adjacent scene is shorter, so a slow fade never eats an entire brief scene.
 */
export function computeSceneMix(scenes: Scene[], t: number, currentIdx: number, transitionSec: number): SceneMix {
  const idx = Math.min(scenes.length - 1, Math.max(0, currentIdx));
  const half = transitionSec / 2;

  if (idx > 0) {
    const prev = scenes[idx - 1];
    const cur = scenes[idx];
    const boundary = cur.start;
    const win = Math.min(half, (prev.end - prev.start) / 2, (cur.end - cur.start) / 2);
    if (win > 0 && t >= boundary - win && t <= boundary + win) {
      return { a: idx - 1, b: idx, mix: clamp01((t - (boundary - win)) / (2 * win)) };
    }
  }

  if (idx < scenes.length - 1) {
    const cur = scenes[idx];
    const next = scenes[idx + 1];
    const boundary = cur.end;
    const win = Math.min(half, (cur.end - cur.start) / 2, (next.end - next.start) / 2);
    if (win > 0 && t >= boundary - win && t <= boundary + win) {
      return { a: idx, b: idx + 1, mix: clamp01((t - (boundary - win)) / (2 * win)) };
    }
  }

  return { a: idx, b: idx, mix: 0 };
}
