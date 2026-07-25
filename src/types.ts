/** A transcribed word with absolute timestamps (seconds). `p` marks the start of a transcript segment (a natural phrase boundary). */
export interface Word {
  w: string;
  s: number;
  e: number;
  p?: boolean;
}

export type ImageStatus = 'none' | 'generating' | 'ready' | 'error';

export interface Scene {
  id: string;
  /** Absolute start/end in seconds. Scenes always tile the full audio: no gaps, no overlaps. */
  start: number;
  end: number;
  /** Index range into project.words (end exclusive). */
  wordStart: number;
  wordEnd: number;
  /** On-screen script text — editable; never affects audio timing. */
  text: string;
  /** Image prompt, pre-filled from the script. */
  prompt: string;
  imageId: string | null;
  imageStatus: ImageStatus;
  imageError?: string;
}

/** One transcription unit (~10 min of audio). `words === null` means not yet transcribed, enabling resume-on-retry. */
export interface Chunk {
  startSec: number;
  endSec: number;
  words: Word[] | null;
}

/** Subtitle anchor, normalized to the stage (0–1). {0.5, 0.5} is dead center. */
export interface CaptionPos {
  x: number;
  y: number;
}

/**
 * How the subtitle is revealed against the audio:
 *   'highlight' — the full caption sits on screen and each word lights up (karaoke marker sweep).
 *   'word'      — the frame starts captionless and each word rises in one at a time as it's spoken.
 *   'static'    — the whole caption is shown, fully lit, for the scene's duration (no animation).
 */
export type CaptionStyle = 'highlight' | 'word' | 'static';

/**
 * How each word animates in during the 'word' caption style: 'fade' rises and fades into place,
 * 'none' pops in instantly at full opacity. Only meaningful for that style — 'highlight' and 'static'
 * ignore it.
 */
export type CaptionEntrance = 'none' | 'fade';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  /** Last time the project was saved — drives "recently edited" ordering in the project list. */
  updatedAt: number;
  audioName: string;
  duration: number;
  peaks: number[];
  /** Project-wide style descriptor appended to every image prompt. */
  style: string;
  /** Subtitle font id (see lib/fonts). */
  captionFont: string;
  /** Subtitle position within the preview. */
  captionPos: CaptionPos;
  /** Marker color for ==highlighted== subtitle text. */
  highlightColor: string;
  /** Uniform background dimming behind the subtitle: 0 = black, 1 = original image brightness. */
  bgBrightness: number;
  /** Subtitle size multiplier (1 = default auto-fit size). */
  captionScale: number;
  /** How the subtitle animates against the audio. */
  captionStyle: CaptionStyle;
  /** How each word animates in when captionStyle is 'word'. */
  captionEntrance: CaptionEntrance;
  /**
   * Hand-corrections to transcript word timing, in seconds, keyed by ABSOLUTE index into `words`.
   * Keyed by source index (not by position in a scene's on-screen text) so a correction survives
   * editing the text. Shifts a word's whole [s, e] span; affects karaoke only, never scene bounds.
   */
  wordOffsets: Record<number, number>;
  /**
   * Timing corrections for displayed words with NO transcript match (words added or reworded in a
   * scene's text — their karaoke time is interpolated between transcript neighbours). Keyed by
   * scene id → displayed-word occurrence key (see WordSpec.key in lib/caption). Transcript-matched
   * words keep their corrections in `wordOffsets`.
   */
  sceneWordOffsets: Record<string, Record<string, number>>;
  words: Word[];
  scenes: Scene[];
  chunks: Chunk[] | null;
  transcribed: boolean;
  /** Running tally of Gemini API usage for this project, so cost stays visible while you work. */
  usage: UsageStats;
}

/** Accumulated Gemini API usage for one project. Costs are an estimate — see lib/gemini.ts pricing table. */
export interface UsageStats {
  transcribeCalls: number;
  promptCalls: number;
  imageCalls: number;
  imagesGenerated: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export const EMPTY_USAGE: UsageStats = {
  transcribeCalls: 0,
  promptCalls: 0,
  imageCalls: 0,
  imagesGenerated: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUSD: 0,
};
