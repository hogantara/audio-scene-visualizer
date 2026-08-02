import type { CaptionEntrance, CaptionStyle, Word } from '../types';
import { MAX_DP_CELLS, lcsMatch, normalize } from './align';
import { paceSpans } from './pace';
import type { SourceWord } from './scenes';
import { TRANSITION_SEC } from './transition';

/** A run of characters sharing the same inline formatting. */
export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  highlight: boolean;
}

/** A single word with its formatting and karaoke start/end times. */
export interface WordSpec {
  text: string;
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  start: number;
  end: number;
  /**
   * Index (into the scene's source words) of the transcript word this displayed word matched, or -1
   * for a word the transcript doesn't know about (added/reworded) whose timing is interpolated.
   */
  srcIndex: number;
  /**
   * Identity of this displayed word within its scene: normalized text plus occurrence number
   * ("word#0"). Keyed on content rather than position so a per-word timing correction survives
   * edits elsewhere in the text (see Project.sceneWordOffsets).
   */
  key: string;
  /**
   * The word's automatic timing — matching/interpolation plus window fitting, before any hand
   * correction. What an offset of 0 restores, and what an offset is measured from.
   */
  baseStart: number;
  baseEnd: number;
}

/** A laid-out word: formatting + karaoke time + x offset and measured width within its visual line. */
export interface LWord extends WordSpec {
  x: number;
  w: number;
}
export interface LLine {
  words: LWord[];
  width: number;
}
export interface CaptionLayout {
  fontSizePx: number;
  lineHeightPx: number;
  lines: LLine[];
  blockWidth: number;
  blockHeight: number;
}

/** Fraction of the frame width used as the caption font-size ceiling / floor for auto-fit. */
export const MAX_FONT_FRACTION = 0.075;
export const MIN_FONT_FRACTION = 0.018;
export const CAPTION_MAX_WIDTH = 0.9;
export const CAPTION_MAX_HEIGHT = 0.86;
export const LINE_HEIGHT_FACTOR = 1.28;

/**
 * Parse one physical line into formatted runs. Supported inline markup:
 *   **bold**   *italic* or _italic_   ==highlight==
 * Markers toggle state, so combinations like **==word==** work; unmatched markers style the rest.
 */
export function parseInline(line: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let highlight = false;
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push({ text: buf, bold, italic, highlight });
      buf = '';
    }
  };
  let i = 0;
  while (i < line.length) {
    const two = line.slice(i, i + 2);
    if (two === '**') {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (two === '==') {
      flush();
      highlight = !highlight;
      i += 2;
      continue;
    }
    const c = line[i];
    if (c === '*' || c === '_') {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return runs;
}

/** Remove markup markers (for plain-text previews such as the scene list). */
export function stripMarkup(text: string): string {
  return text.replace(/\*\*|==|[*_]/g, '');
}

type PlainWord = Omit<WordSpec, 'start' | 'end' | 'srcIndex' | 'key' | 'baseStart' | 'baseEnd'>;

function runsToWords(runs: Run[]): PlainWord[] {
  const words: PlainWord[] = [];
  for (const r of runs) {
    for (const tok of r.text.split(/\s+/)) {
      if (tok === '') continue;
      words.push({ text: tok, bold: r.bold, italic: r.italic, highlight: r.highlight });
    }
  }
  return words;
}

/**
 * Give words [from, to) a slice of [a, b] each, in proportion to how long they take to say (see
 * lib/pace) rather than an equal share — these are the words the transcript has no time for, so the
 * only thing keeping them with the voice is the estimate. A zero-width span collapses them onto `a`.
 */
function spread(flat: WordSpec[], from: number, to: number, a: number, b: number): void {
  if (to - from <= 0) return;
  const spans = paceSpans(
    flat.slice(from, to).map((w) => w.text),
    a,
    b
  );
  for (let k = 0; k < spans.length; k++) {
    flat[from + k].start = spans[k].s;
    flat[from + k].end = spans[k].e;
  }
}

/**
 * Time the displayed words from the scene's transcript words.
 *
 * Displayed text is user-editable and carries inline markup, so it routinely tokenizes to a
 * different word count than the transcript. Matching by position would then silently stretch every
 * later word (a deleted filler word drags the rest of the scene out of sync), so words are matched
 * by TEXT instead: an LCS pins every surviving word to its own exact timestamp, and only genuinely
 * new words are interpolated — across the silence between the words that bracket them.
 */
function assignTimes(flat: WordSpec[], src: Word[], sceneStart: number): void {
  const n = flat.length;
  const m = src.length;
  if (n === 0) return;
  if (m === 0) {
    spread(flat, 0, n, sceneStart, sceneStart);
    return;
  }
  const t0 = src[0].s;
  const t1 = src[m - 1].e;
  if (n * m > MAX_DP_CELLS) {
    spread(flat, 0, n, t0, t1);
    return;
  }

  const match = lcsMatch(flat.map((w) => normalize(w.text)), src.map((w) => normalize(w.w)));
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = match[i];
    if (j >= 0) {
      flat[i].start = src[j].s;
      flat[i].end = src[j].e;
      flat[i].srcIndex = j;
      anchors.push(i);
    }
  }
  if (anchors.length === 0) {
    spread(flat, 0, n, t0, t1);
    return;
  }
  // Interpolate each unmatched run into the gap left by the anchors bracketing it.
  spread(flat, 0, anchors[0], t0, flat[anchors[0]].start);
  for (let k = 0; k + 1 < anchors.length; k++) {
    const lo = anchors[k];
    const hi = anchors[k + 1];
    spread(flat, lo + 1, hi, flat[lo].end, flat[hi].start);
  }
  const last = anchors[anchors.length - 1];
  spread(flat, last + 1, n, flat[last].end, t1);
}

/**
 * When timing is refitted, leave this long after the last word (or 25% of the scene, whichever is
 * smaller). Matched to the crossfade/closing-fade length so recovered words land before the frame
 * starts fading out — otherwise the final scene's tail would be technically drawn but fading to black
 * exactly as it appeared, which is indistinguishable from the bug being fixed.
 */
const REFIT_TAIL = TRANSITION_SEC;
/**
 * Minimum spacing between consecutive word reveals. Below this the words stop reading as words
 * arriving one by one and become a single flash, which looks identical to them never appearing.
 */
const MIN_WORD_GAP = 0.28;

/**
 * Guarantee every displayed word gets a *readable* reveal while its scene is on screen.
 *
 * Karaoke times come from the transcript, and a transcript can both claim time the audio does not
 * have and crush a whole run of words into a few frames (one segment with a wildly overstated end
 * leaves the words after it sharing whatever sliver is left). Either way the words are present in the
 * editor but effectively absent from the preview — unreachable in the first case, an unreadable
 * flash in the second.
 *
 * The correction walks backward from the scene's cut, pulling any word that reveals too late (or too
 * close to its neighbour) earlier. Because each step is a `min`, a word that already reveals in time
 * keeps its transcribed timing untouched — healthy speech still tracks the audio exactly, and only a
 * crushed tail actually moves.
 *
 * Runs BEFORE hand corrections (see `buildWordLines`): the fit repairs the transcript's own timing,
 * and a user's explicit nudge is then applied on top, authoritative over these heuristics.
 */
function fitToWindow(flat: WordSpec[], sceneStart: number, sceneEnd: number): void {
  const n = flat.length;
  if (n === 0) return;
  const span = sceneEnd - sceneStart;
  if (!(span > 0)) return;

  const limit = sceneEnd - Math.min(REFIT_TAIL, span * 0.25);
  if (!(limit > sceneStart)) return;

  const starts = flat.map((w) => w.start);
  starts[n - 1] = Math.min(starts[n - 1], limit);
  for (let i = n - 2; i >= 0; i--) starts[i] = Math.min(starts[i], starts[i + 1] - MIN_WORD_GAP);

  if (starts[0] < sceneStart) {
    // Pulling the tail earlier ran past the start of the scene; re-seat from the front instead.
    starts[0] = sceneStart;
    for (let i = 1; i < n; i++) starts[i] = Math.max(starts[i], starts[i - 1] + MIN_WORD_GAP);
    if (starts[n - 1] > limit) {
      // The scene simply cannot hold this many words at a readable pace — share it out evenly.
      spread(flat, 0, n, sceneStart, limit);
      return;
    }
  }
  if (starts.every((s, i) => s === flat[i].start)) return;

  for (let i = 0; i < n; i++) {
    const nextStart = i + 1 < n ? starts[i + 1] : sceneEnd;
    flat[i].start = starts[i];
    flat[i].end = Math.max(starts[i], Math.min(flat[i].end, nextStart));
  }
}

/** A hand-corrected start is kept at least this far before the cut — at the cut it can't be seen. */
const SCENE_END_EPS = 0.05;

/**
 * Turn scene text into physical lines of timed words. Hard line breaks (`\n`) are preserved.
 * Karaoke times come from matching the displayed words against the scene's transcript words, so
 * highlighting keeps tracking the audio after the text is edited or marked up. Words the transcript
 * doesn't know about get interpolated times. `sceneEnd` bounds the automatic result so no word is
 * left with a reveal the playhead can never reach (see `fitToWindow`).
 *
 * Hand corrections are applied LAST — matched words carry theirs as `off` on `sourceWords` (see
 * `sceneWords`), added words look theirs up in `extraOffsets` by occurrence key — so an explicit
 * nudge always moves the word, overriding the automatic fit. They're clamped only to the scene
 * window itself.
 */
export function buildWordLines(
  text: string,
  sourceWords: SourceWord[],
  sceneStart: number,
  sceneEnd: number,
  extraOffsets?: Record<string, number>
): WordSpec[][] {
  const physical = text.split('\n');
  const specLines: WordSpec[][] = physical.map((line) =>
    runsToWords(parseInline(line)).map((w) => ({
      ...w,
      start: sceneStart,
      end: sceneStart,
      srcIndex: -1,
      key: '',
      baseStart: sceneStart,
      baseEnd: sceneStart,
    }))
  );
  const flat = specLines.flat();
  const seen = new Map<string, number>();
  for (const w of flat) {
    const base = normalize(w.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    w.key = `${base}#${n}`;
  }
  assignTimes(flat, sourceWords, sceneStart);
  fitToWindow(flat, sceneStart, sceneEnd);
  for (const w of flat) {
    w.baseStart = w.start;
    w.baseEnd = w.end;
  }
  // Hand corrections go on top of the fitted times so they're never clamped away by the automatic
  // repair — only the scene window itself bounds them.
  const latestStart = Math.max(sceneStart, sceneEnd - SCENE_END_EPS);
  for (const w of flat) {
    const off = w.srcIndex >= 0 ? sourceWords[w.srcIndex].off : extraOffsets?.[w.key];
    if (!off) continue;
    w.start = Math.min(Math.max(w.baseStart + off, sceneStart), latestStart);
    w.end = Math.max(w.start, Math.min(w.baseEnd + off, sceneEnd));
  }
  return specLines;
}

export type MeasureFn = (text: string, bold: boolean, italic: boolean, sizePx: number) => number;

/** Build a text-measuring function bound to a font family and its normal/bold weights. */
export function makeMeasure(family: string, weightNormal: number, weightBold: number): MeasureFn {
  const ctx = document.createElement('canvas').getContext('2d')!;
  return (text, bold, italic, sizePx) => {
    ctx.font = `${italic ? 'italic ' : ''}${bold ? weightBold : weightNormal} ${sizePx}px ${family}`;
    return ctx.measureText(text).width;
  };
}

export interface LayoutOpts {
  measure: MeasureFn;
  maxWidth: number;
  maxHeight: number;
  maxFontPx: number;
  minFontPx: number;
  lineHeightFactor: number;
}

/**
 * Lay out timed word lines: wrap each physical line to `maxWidth`, and auto-fit the font size so the
 * whole block fits within `maxWidth` × `maxHeight` — i.e. every word is visible.
 */
export function layoutCaption(wordLines: WordSpec[][], opts: LayoutOpts): CaptionLayout {
  const { measure, maxWidth, maxHeight, maxFontPx, minFontPx, lineHeightFactor } = opts;

  const build = (size: number): CaptionLayout => {
    const spaceW = measure(' ', false, false, size);
    const lines: LLine[] = [];
    for (const wl of wordLines) {
      if (wl.length === 0) {
        lines.push({ words: [], width: 0 });
        continue;
      }
      let cur: LWord[] = [];
      let curW = 0;
      for (const w of wl) {
        const ww = measure(w.text, w.bold, w.italic, size);
        if (cur.length > 0 && curW + spaceW + ww > maxWidth) {
          lines.push({ words: cur, width: curW });
          cur = [];
          curW = 0;
        }
        const x = cur.length > 0 ? curW + spaceW : 0;
        cur.push({ ...w, x, w: ww });
        curW = x + ww;
      }
      lines.push({ words: cur, width: curW });
    }
    const blockWidth = lines.reduce((m, l) => Math.max(m, l.width), 0);
    const lineHeightPx = size * lineHeightFactor;
    return { fontSizePx: size, lineHeightPx, lines, blockWidth, blockHeight: lines.length * lineHeightPx };
  };

  for (let size = Math.round(maxFontPx); size >= minFontPx; size -= 1) {
    const layout = build(size);
    if (layout.blockWidth <= maxWidth && layout.blockHeight <= maxHeight) return layout;
  }
  return build(Math.round(minFontPx));
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '000000', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Dark or white text, whichever contrasts better with the given (highlight) color. */
export function contrastText(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#171310' : '#ffffff';
}

/**
 * Darken the frame uniformly so text stays readable wherever it's positioned. `brightness` is
 * 0 (fully black) to 1 (original image, no dimming). Used by BOTH the preview canvas and the MP4
 * exporter so the on-screen darkness always matches the exported video.
 */
export function drawScrim(ctx: CanvasRenderingContext2D, W: number, H: number, brightness: number): void {
  const dim = 1 - Math.min(1, Math.max(0, brightness));
  if (dim <= 0) return;
  ctx.fillStyle = `rgba(0,0,0,${dim})`;
  ctx.fillRect(0, 0, W, H);
}

/** Deterministic per-stroke PRNG so the marker texture is identical every frame and in export. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Multiply a hex color's channels by `f` (<1 darkens) — used for the marker's streaks and wet tip. */
function shade(hex: string, f: number): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
}

/**
 * Paint one highlighter stroke like a real marker dragged across paper (Vox-style): the ink sweeps
 * in left-to-right up to `front`, sits inside faintly uneven top/bottom edges, carries streaky grain,
 * ends in a chisel-angled tip, and pools a little wet ink at that tip while it's still moving.
 *
 * `front` is the x the marker tip has reached (derived from karaoke timing). While it's still inside
 * the run the leading edge is a slanted, wet chisel tip; once it passes the whole run the stroke is
 * fully painted with a clean vertical end (so adjacent word-by-word segments tile seamlessly). The
 * whole stroke is scaled by `alpha`, letting the word-by-word style fade a band in with its word.
 * All geometry is seeded from `seed`, so the texture never shimmers between frames or between the
 * live preview and the exported video.
 */
function drawHighlighterStroke(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  cy: number,
  h: number,
  color: string,
  front: number,
  seed: number,
  alpha = 1,
): void {
  const paintTo = Math.min(front, x1);
  if (paintTo <= x0 || alpha <= 0.001) return;
  const sweeping = front < x1;
  const rng = makeRng(seed);
  const half = h / 2;
  const tip = h * 0.18; // chisel angle of the marker tip
  const jitter = h * 0.09;

  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Clip to the painted region. Mid-sweep the leading edge slants like a chisel-tip marker; once the
  // run is fully painted the end is a clean vertical, so neighbouring segments abut without a seam.
  ctx.beginPath();
  if (sweeping) {
    ctx.moveTo(x0 - h, cy - h);
    ctx.lineTo(paintTo + tip / 2, cy - h);
    ctx.lineTo(paintTo - tip / 2, cy + h);
    ctx.lineTo(x0 - h, cy + h);
    ctx.closePath();
  } else {
    ctx.rect(x0 - h, cy - h, paintTo - x0 + h, 2 * h);
  }
  ctx.clip();

  // Band outline with faintly uneven top and bottom, as if paper texture and pressure weren't even.
  const segs = Math.max(3, Math.round((x1 - x0) / (h * 0.9)));
  const xAt = (k: number) => x0 + ((x1 - x0) * k) / segs;
  const topY: number[] = [];
  const botY: number[] = [];
  for (let k = 0; k <= segs; k++) topY.push(cy - half + (rng() - 0.5) * jitter);
  for (let k = 0; k <= segs; k++) botY.push(cy + half + (rng() - 0.5) * jitter);
  ctx.beginPath();
  ctx.moveTo(xAt(0), topY[0]);
  for (let k = 1; k <= segs; k++) ctx.lineTo(xAt(k), topY[k]);
  for (let k = segs; k >= 0; k--) ctx.lineTo(xAt(k), botY[k]);
  ctx.closePath();

  // Base ink — slightly translucent so it reads as marker, not a filled box.
  ctx.globalAlpha = 0.9 * alpha;
  ctx.fillStyle = color;
  ctx.fill();

  // Streaks: a few darker horizontal passes give the stroke its grain.
  const [sr, sg, sb] = shade(color, 0.8);
  ctx.lineCap = 'round';
  const streaks = 2 + Math.floor(rng() * 2);
  for (let k = 0; k < streaks; k++) {
    const y = cy - half + h * (0.12 + rng() * 0.72);
    ctx.globalAlpha = (0.08 + rng() * 0.12) * alpha;
    ctx.strokeStyle = `rgb(${sr},${sg},${sb})`;
    ctx.lineWidth = h * (0.04 + rng() * 0.06);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  // Wet ink pooling at the tip while the marker is still travelling.
  if (sweeping) {
    const [tr, tg, tb] = shade(color, 0.72);
    const grad = ctx.createLinearGradient(paintTo - h * 1.1, 0, paintTo + tip, 0);
    grad.addColorStop(0, `rgba(${tr},${tg},${tb},0)`);
    grad.addColorStop(1, `rgba(${tr},${tg},${tb},${0.45 * alpha})`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fillRect(paintTo - h * 1.3, cy - half - jitter, h * 1.3 + tip, h + jitter * 2);
  }

  ctx.restore();
}

export interface DrawOpts {
  layout: CaptionLayout;
  t: number;
  W: number;
  H: number;
  posX: number;
  posY: number;
  family: string;
  weightNormal: number;
  weightBold: number;
  highlightColor: string;
  /** How the caption animates against the audio (see CaptionStyle). */
  style: CaptionStyle;
  /** How each word pops in during the word-by-word style (see CaptionEntrance). Unused otherwise. */
  entrance: CaptionEntrance;
}

/** Opacity of an unspoken word, relative to a lit one. */
const KARAOKE_DIM = 0.45;
/** Seconds a word takes to brighten. Centered on its onset, so it reads as lit exactly on the beat. */
const KARAOKE_RAMP = 0.09;
/** Seconds a word takes to glide and fade into place in the word-by-word style, when animated. */
const WORD_APPEAR = 0.5;

/**
 * Karaoke opacity for one word at time `t` (already remapped onto the transcript timeline).
 * The brightening is ramped rather than switched: a hard step makes a small timing error read as a
 * visibly early/late snap, whereas a short ramp is perceived at its midpoint and absorbs it.
 */
function wordAlpha(w: LWord, t: number): number {
  return KARAOKE_DIM + (1 - KARAOKE_DIM) * revealProgress(w, t);
}

/**
 * How "revealed" a word is at time `t`, on the same onset-centered ramp as `wordAlpha`: 0 before
 * it's spoken, 1 once fully spoken. Drives the highlight band's fade-in so a highlighted word shows
 * no color at all until its own karaoke moment — the caption starts completely clean.
 */
function revealProgress(w: LWord, t: number): number {
  // Never outrun the word itself — a very short word ramps over its own duration instead.
  const ramp = Math.max(0.01, Math.min(KARAOKE_RAMP, w.end - w.start || KARAOKE_RAMP));
  return Math.min(1, Math.max(0, (t - (w.start - ramp / 2)) / ramp));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Word-by-word entrance progress: 0 before the word is spoken. With 'fade', eases to 1 over
 * WORD_APPEAR seconds from its onset (ease-out quart, a soft, drawn-out deceleration so the word
 * glides gently into place rather than snapping); with 'none' it jumps straight to 1 at onset — an
 * instant pop, no animation.
 */
function appearProgress(entrance: CaptionEntrance, w: LWord, t: number): number {
  if (t < w.start) return 0;
  if (entrance === 'none') return 1;
  const p = Math.min(1, (t - w.start) / WORD_APPEAR);
  return 1 - Math.pow(1 - p, 4);
}

/**
 * Word-by-word reveal: the frame starts captionless and each word appears in its final laid-out
 * position as it's spoken — gently popping up into place, rising a touch as it fades and eases up
 * from slightly small to full size ('fade' entrance), or popping in instantly ('none'). The motion
 * is slow and soft so each word settles elegantly. Highlighted words bring their marker band in too.
 */
function drawWordByWord(
  ctx: CanvasRenderingContext2D,
  o: DrawOpts,
  cx: number,
  startY: number,
  size: number,
  markText: string,
): void {
  const { layout, t, family, weightNormal, weightBold, highlightColor, entrance } = o;
  const [mr, mg, mb] = hexToRgb(markText);
  const padX = size * 0.16;
  const bandH = size * 1.02;
  const animated = entrance === 'fade';

  layout.lines.forEach((line, li) => {
    if (line.words.length === 0) return;
    const lineY = startY + li * layout.lineHeightPx + layout.lineHeightPx / 2;
    const lineStartX = cx - line.width / 2;

    line.words.forEach((w, wi) => {
      const ap = appearProgress(entrance, w, t);
      if (ap <= 0) return;
      const wx = lineStartX + w.x;
      const wcx = wx + w.w / 2;
      // Gentle pop-up: the word starts a little below its slot and slightly small, then rises and
      // eases up to full size as it fades in. Slow and soft, so it settles rather than snaps.
      const rise = animated ? (1 - ap) * size * 0.32 : 0;
      const scale = animated ? 0.9 + 0.1 * ap : 1;

      ctx.save();
      // Let the fade run a touch ahead of the motion so the word is legible while it's still settling.
      ctx.globalAlpha = animated ? Math.min(1, ap * 1.1) : 1;
      // Rise + subtle scale-up about the word's own centre.
      ctx.translate(wcx, lineY + rise);
      ctx.scale(scale, scale);
      ctx.translate(-wcx, -lineY);

      if (w.highlight) {
        // Tile a highlighted run seamlessly: split the gap to any neighbouring highlighted word.
        const prev = line.words[wi - 1];
        const next = line.words[wi + 1];
        const bx0 =
          prev && prev.highlight ? (lineStartX + prev.x + prev.w + wx) / 2 : wx - padX;
        const bx1 =
          next && next.highlight ? (wx + w.w + lineStartX + next.x) / 2 : wx + w.w + padX;
        const seed = (li * 2654435761 + Math.round(bx0) * 40503 + wi * 97) >>> 0;
        drawHighlighterStroke(ctx, bx0, bx1, lineY, bandH, highlightColor, bx1, seed, ap);
      }

      ctx.font = `${w.italic ? 'italic ' : ''}${w.bold ? weightBold : weightNormal} ${size}px ${family}`;
      if (w.highlight) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = `rgb(${mr},${mg},${mb})`;
      } else {
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = size * 0.22;
        ctx.shadowOffsetY = size * 0.04;
        ctx.fillStyle = '#ffffff';
      }
      ctx.fillText(w.text, wx, lineY);
      ctx.restore();
    });
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * Draw a laid-out caption. Used by BOTH the in-app preview canvas and the MP4 exporter, so the
 * exported frame is identical to the preview. The `style` picks how it animates: 'highlight' sweeps
 * a karaoke marker across a fully-present caption, 'word' rises each word in one at a time from an
 * empty frame (its `entrance` controls whether that rise animates or pops in instantly), and 'static'
 * shows the whole caption fully lit.
 */
export function drawCaptionLayout(ctx: CanvasRenderingContext2D, o: DrawOpts): void {
  const { layout, t, W, H, posX, posY, family, weightNormal, weightBold, highlightColor, style } = o;
  if (layout.lines.length === 0) return;
  const cx = posX * W;
  const cy = posY * H;
  const startY = cy - layout.blockHeight / 2;
  const size = layout.fontSizePx;
  const markText = contrastText(highlightColor);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (style === 'word') {
    drawWordByWord(ctx, o, cx, startY, size, markText);
    return;
  }

  // Word times already carry any hand-correction (applied in `buildWordLines` after window
  // fitting), so playback time needs no remapping. Infinity lights every word at once, i.e. the
  // static style.
  const karaokeT = style === 'highlight' ? t : Infinity;

  layout.lines.forEach((line, li) => {
    if (line.words.length === 0) return;
    const lineY = startY + li * layout.lineHeightPx + layout.lineHeightPx / 2;
    const lineStartX = cx - line.width / 2;

    // Highlighter marker strokes behind each contiguous highlighted run. The ink sweeps in
    // left-to-right in step with the karaoke timing, so a run stays completely clean until spoken.
    const padX = size * 0.16;
    const bandH = size * 1.02;
    let i = 0;
    while (i < line.words.length) {
      if (line.words[i].highlight) {
        let j = i;
        while (j + 1 < line.words.length && line.words[j + 1].highlight) j++;
        const bandX0 = lineStartX + line.words[i].x - padX;
        const bandX1 = lineStartX + line.words[j].x + line.words[j].w + padX;

        // Marker tip position: fully-swept segments for spoken words plus a partial segment for the
        // word being spoken. Segment boundaries sit at the midpoints between neighbouring words.
        // Hand nudges can make reveals non-monotonic; the sweep stops at the first unrevealed word,
        // so a word nudged ahead of its neighbour brightens on time but is inked once the run
        // catches up — consistent with a physical marker.
        let front = bandX0;
        for (let k = i; k <= j; k++) {
          const R = lineStartX + line.words[k].x + line.words[k].w;
          const segStart =
            k === i ? bandX0 : (lineStartX + line.words[k - 1].x + line.words[k - 1].w + lineStartX + line.words[k].x) / 2;
          const segEnd = k === j ? bandX1 : (R + lineStartX + line.words[k + 1].x) / 2;
          const p = revealProgress(line.words[k], karaokeT);
          if (p >= 1) {
            front = segEnd;
          } else {
            front = segStart + p * (segEnd - segStart);
            break;
          }
        }

        if (front > bandX0) {
          const seed = (li * 2654435761 + Math.round(bandX0) * 40503 + i * 97) >>> 0;
          drawHighlighterStroke(ctx, bandX0, bandX1, lineY, bandH, highlightColor, front, seed);
        }
        i = j + 1;
      } else {
        i++;
      }
    }

    // Text, with per-word karaoke opacity. Highlighted words cross-fade from the plain unlit style
    // into the marker text color exactly as their band fades in.
    const [mr, mg, mb] = hexToRgb(markText);
    for (const w of line.words) {
      const alpha = wordAlpha(w, karaokeT);
      const revealed = w.highlight ? revealProgress(w, karaokeT) : 0;
      ctx.font = `${w.italic ? 'italic ' : ''}${w.bold ? weightBold : weightNormal} ${size}px ${family}`;
      if (revealed > 0) {
        const r = lerp(255, mr, revealed);
        const g = lerp(255, mg, revealed);
        const b = lerp(255, mb, revealed);
        const shadowAlpha = 0.9 * alpha * (1 - revealed);
        ctx.shadowColor = shadowAlpha > 0.001 ? `rgba(0,0,0,${shadowAlpha})` : 'transparent';
        ctx.shadowBlur = size * 0.22 * (1 - revealed);
        ctx.shadowOffsetY = size * 0.04 * (1 - revealed);
        ctx.fillStyle = `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
      } else {
        ctx.shadowColor = `rgba(0,0,0,${0.9 * alpha})`;
        ctx.shadowBlur = size * 0.22;
        ctx.shadowOffsetY = size * 0.04;
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      }
      ctx.fillText(w.text, lineStartX + w.x, lineY);
    }
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}
