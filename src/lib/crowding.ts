/**
 * Caption crowding: detecting a scene whose text is too dense to read comfortably, and splitting it
 * into two scenes that each still deliver a complete thought.
 *
 * Crowding is judged from the SAME auto-fit the renderer already performs (`layoutCaption`), at the
 * export frame — so the verdict is exactly the layout the viewer will get, not a proxy for it, and
 * it doesn't drift with the size of the editor's preview pane.
 */

import type { Project, Scene, Word } from '../types';
import { lcsMatch, normalize } from './align';
import {
  CAPTION_MAX_HEIGHT,
  CAPTION_MAX_WIDTH,
  LINE_HEIGHT_FACTOR,
  MAX_FONT_FRACTION,
  MIN_FONT_FRACTION,
  buildWordLines,
  layoutCaption,
  stripMarkup,
  type CaptionLayout,
  type MeasureFn,
} from './caption';
import { PAUSE_GAP, SENTENCE_END, sceneWords, splitScene } from './scenes';

/** The frame crowding is judged at — the export size, so the verdict matches the delivered video. */
const FRAME_W = 1920;
const FRAME_H = 1080;

/**
 * Comfort floor for the auto-fitted caption font, as a fraction of frame width (scaled by the
 * project's caption size, like every other font fraction).
 *
 * Deliberately well above `MIN_FONT_FRACTION`: that constant is the point where the layout gives up,
 * so a caption that has fallen to it is already unreadable — a trigger there would only ever fire
 * after the damage. 0.036 is ~69px on a 1080p frame, about 50 characters to a line, which is the
 * point where a caption stops reading as a line of speech and starts reading as a paragraph.
 */
export const COMFORT_FONT_FRACTION = 0.036;

/**
 * Backstop for the wide-and-short case the font floor misses: a caption can keep a comfortable font
 * size and still wall off the frame by stacking lines. Five is the most a 16:9 frame carries without
 * the image becoming a background for a block of text.
 */
export const MAX_COMFORT_LINES = 5;

/** Neither half of a split may be shorter than this — a sliver scene reads as a flash, not a shot. */
export const MIN_SPLIT_SEC = 3;

/**
 * How many times one original scene may be split. A scene that is still crowded after this many
 * splits is flagged for a human instead: past here the text is dense enough that the problem is the
 * script, and shredding it further just replaces one unreadable scene with a burst of short ones.
 */
export const MAX_SPLIT_DEPTH = 3;

/** Clause-level punctuation — the fallback boundary when a scene holds no sentence end to cut at. */
const CLAUSE_END = /[,;:—–-]["”')\]]*$/;

/** Lay out a scene's caption exactly as the exporter would, at the fixed export frame. */
export function layoutScene(p: Project, s: Scene, measure: MeasureFn): CaptionLayout {
  const wordLines = buildWordLines(s.text, sceneWords(p, s), s.start, s.end, p.sceneWordOffsets?.[s.id]);
  return layoutCaption(wordLines, {
    measure,
    maxWidth: FRAME_W * CAPTION_MAX_WIDTH,
    maxHeight: FRAME_H * CAPTION_MAX_HEIGHT,
    maxFontPx: FRAME_W * MAX_FONT_FRACTION * p.captionScale,
    minFontPx: FRAME_W * MIN_FONT_FRACTION * p.captionScale,
    lineHeightFactor: LINE_HEIGHT_FACTOR,
  });
}

/**
 * Is this laid-out caption too crowded to read? True when the auto-fit had to shrink past the
 * comfort floor, or when it kept the size by stacking more lines than the frame carries.
 */
export function isCrowded(layout: CaptionLayout, captionScale: number): boolean {
  if (layout.lines.length === 0) return false;
  const comfortPx = FRAME_W * COMFORT_FONT_FRACTION * captionScale;
  if (layout.fontSizePx < comfortPx) return true;
  return layout.lines.filter((l) => l.words.length > 0).length > MAX_COMFORT_LINES;
}

/** One whitespace-separated token of a scene's displayed text, with where it starts in that text. */
interface TextToken {
  raw: string;
  /** Markup stripped — what the viewer actually reads, and what matches the transcript. */
  plain: string;
  at: number;
}

/** Tokenize displayed text, keeping each token's offset so the text can be cut at a token boundary. */
function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], plain: stripMarkup(m[0]), at: m.index });
  }
  return out;
}

interface Candidate {
  /** Index into the scene's displayed tokens of the token that starts the second half. */
  token: number;
  /** Index into the scene's transcript words (relative to the scene) of the same boundary. */
  relWord: number;
  /** 0 = sentence boundary, 1 = clause boundary. Lower tiers are always preferred. */
  tier: number;
  /** Characters in the larger of the two halves — the crowding the split leaves behind. */
  worstHalf: number;
}

/**
 * Choose where to split a crowded scene, or return null if there is no defensible place to cut.
 *
 * Boundaries come from the same vocabulary `autoChunk` already cuts on — sentence ends, transcript
 * segment starts, and pauses — so an automatic split lands where the narration itself pauses rather
 * than at an arbitrary midpoint. Sentence ends are taken first; only if the scene holds none does it
 * fall back to clause boundaries (comma/semicolon/dash, or a real pause in the audio). One long
 * unbroken sentence therefore yields nothing here and is left for a human, which is the right
 * outcome: there is no way to halve it that leaves two complete thoughts.
 *
 * Among the boundaries of the best available tier it picks the one that minimizes the LARGER half's
 * text — the half that would still be crowded — rather than the one nearest the midpoint, since the
 * whole point of the split is to get both halves under the comfort threshold.
 */
export function findSplit(p: Project, s: Scene): { relWord: number; first: string; second: string } | null {
  const tokens = tokenize(s.text);
  const src: Word[] = p.words.slice(s.wordStart, s.wordEnd);
  if (tokens.length < 2 || src.length < 2) return null;

  // Pin each displayed token to its transcript word. Displayed text is the authored narration (a
  // storyboard import replaces the ASR text with it), so it never lines up with the transcript by
  // position — the same LCS the caption timing uses is what maps a text boundary to a word index.
  const match = lcsMatch(tokens.map((t) => normalize(t.plain)), src.map((w) => normalize(w.w)));

  const total = tokens.reduce((n, t) => n + t.plain.length + 1, 0);
  let best: Candidate | null = null;

  for (let k = 1; k < tokens.length; k++) {
    // The boundary needs a transcript word to cut at: the first matched token at or after it.
    let rel = -1;
    for (let j = k; j < tokens.length; j++) {
      if (match[j] >= 0) {
        rel = match[j];
        break;
      }
    }
    if (rel <= 0 || rel >= src.length) continue;

    // Both halves must be long enough to read as their own shot. Interior boundaries land at the
    // midpoint of the silence between the two words, exactly as `recomputeBounds` will place them.
    const cutT = (src[rel - 1].e + src[rel].s) / 2;
    if (cutT - s.start < MIN_SPLIT_SEC || s.end - cutT < MIN_SPLIT_SEC) continue;

    const prev = tokens[k - 1].plain;
    const gap = src[rel].s - src[rel - 1].e;
    const sentence = SENTENCE_END.test(prev);
    const clause = CLAUSE_END.test(prev) || gap >= PAUSE_GAP || src[rel].p === true;
    if (!sentence && !clause) continue;

    const left = tokens.slice(0, k).reduce((n, t) => n + t.plain.length + 1, 0);
    const cand: Candidate = {
      token: k,
      relWord: rel,
      tier: sentence ? 0 : 1,
      worstHalf: Math.max(left, total - left),
    };
    if (!best || cand.tier < best.tier || (cand.tier === best.tier && cand.worstHalf < best.worstHalf)) {
      best = cand;
    }
  }
  if (!best) return null;

  const first = s.text.slice(0, tokens[best.token].at).trimEnd();
  const second = s.text.slice(tokens[best.token].at);
  if (!first || !second) return null;
  return { relWord: best.relWord, first, second };
}

export interface CrowdingResult {
  /** How many splits were performed. */
  split: number;
  /** Scenes left crowded because no safe split point was found (or the depth cap was reached). */
  flagged: number;
}

/**
 * Split every crowded scene in the project, in place, and mark the ones that could not be fixed.
 *
 * Splitting is repeated on the halves — one pass through a very long scene leaves two scenes that
 * are each still too dense — up to `MAX_SPLIT_DEPTH` per original scene.
 */
export function autoSplitCrowded(p: Project, measure: MeasureFn): CrowdingResult {
  const result: CrowdingResult = { split: 0, flagged: 0 };
  if (p.words.length === 0) return result;
  const depth = new Map<string, number>();

  for (let i = 0; i < p.scenes.length; i++) {
    const s = p.scenes[i];
    if (!isCrowded(layoutScene(p, s, measure), p.captionScale)) {
      if (s.crowded) delete s.crowded;
      continue;
    }
    const d = depth.get(s.id) ?? 0;
    const cut = d < MAX_SPLIT_DEPTH ? findSplit(p, s) : null;
    if (!cut) {
      s.crowded = true;
      result.flagged++;
      continue;
    }
    // The halves are two shots of one authored beat, so the second inherits its artwork and image
    // brief rather than starting blank — this pass is fixing the caption, not the picture.
    const before = p.scenes.length;
    splitScene(p, i, cut.relWord, { text: { first: cut.first, second: cut.second }, inheritImage: true });
    if (p.scenes.length === before) {
      // splitScene refused the index. Can't happen from a `findSplit` result, but re-examining the
      // same scene would spin forever, so treat it as unsplittable.
      s.crowded = true;
      result.flagged++;
      continue;
    }
    for (const half of [p.scenes[i], p.scenes[i + 1]]) {
      half.autoSplit = true;
      delete half.crowded;
      depth.set(half.id, d + 1);
    }
    result.split++;
    i--; // re-examine the first half: it may still be crowded.
  }
  return result;
}

/** How many scenes are currently crowded — drives the editor's "fix crowding" affordance. */
export function countCrowded(p: Project, measure: MeasureFn): number {
  return p.scenes.filter((s) => isCrowded(layoutScene(p, s, measure), p.captionScale)).length;
}
