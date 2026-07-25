import type { Word } from '../types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TEXT_MODEL = 'gemini-2.5-flash';

function url(model: string): string {
  return `${BASE}/${model}:generateContent`;
}

function headers(key: string): HeadersInit {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

/**
 * A single call's contribution to running usage, returned alongside each function's result so the
 * store can accumulate it onto `Project.usage`. Cost is an estimate (see PRICING below) — Gemini
 * doesn't return billed cost, only token/image counts, so this multiplies those by published list
 * prices as of Nov 2025. Re-check ai.google.dev/gemini-api/docs/pricing if it drifts noticeably.
 */
export interface UsageDelta {
  kind: 'transcribe' | 'prompt' | 'image';
  inputTokens: number;
  outputTokens: number;
  images: number;
  costUSD: number;
}

/**
 * Per-model list pricing, $ per 1M tokens (input/output) plus a flat per-image rate for image
 * models, which Gemini bills per output image rather than by output token count. Approximate —
 * intended to give a running order-of-magnitude estimate, not an invoice.
 */
const PRICING: Record<string, { inPer1M: number; outPer1M?: number; perImage?: number }> = {
  'gemini-2.5-flash': { inPer1M: 0.3, outPer1M: 2.5 },
  'gemini-3.1-flash-image': { inPer1M: 0.5, perImage: 0.067 },
  'gemini-3.1-flash-image-preview': { inPer1M: 0.5, perImage: 0.067 },
  'gemini-2.5-flash-image': { inPer1M: 0.3, perImage: 0.039 },
  'gemini-2.0-flash-preview-image-generation': { inPer1M: 0.3, perImage: 0.039 },
};

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

function estimateCost(model: string, usage: UsageMetadata | undefined, images: number): { inputTokens: number; outputTokens: number; costUSD: number } {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const price = PRICING[model];
  if (!price) return { inputTokens, outputTokens, costUSD: 0 };
  let cost = (inputTokens / 1_000_000) * price.inPer1M;
  cost += price.perImage ? images * price.perImage : (outputTokens / 1_000_000) * (price.outPer1M ?? 0);
  return { inputTokens, outputTokens, costUSD: cost };
}

async function apiError(res: Response): Promise<Error & { status: number }> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    if (j.error?.message) message = j.error.message;
  } catch {
    /* keep status text */
  }
  const err = new Error(message) as Error & { status: number };
  err.status = res.status;
  return err;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read audio for upload.'));
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

interface Segment {
  text: string;
  start: number;
  end: number;
}

/**
 * Longest a single word may occupy. A segment claiming more per word has an unreliable end time.
 * Exported for `clampWordsToDuration` (scenes.ts): a word exactly this wide is the signature of the
 * pace cap having synthesized its end, which marks it reclaimable when a broken tail follows it.
 */
export const MAX_WORD_SEC = 1.2;
/** Fallback pace when a segment gives no usable end time at all. */
const FALLBACK_WORD_SEC = 0.3;

/**
 * Transcribe one WAV chunk with Gemini. Gemini returns sentence/phrase-level segments with
 * timestamps; word timings are interpolated evenly within each segment. Timestamps are relative
 * to the chunk, so they're shifted by `offsetSec` to absolute time. The first word of each segment
 * is flagged (`p`) as a natural phrase boundary for scene chunking.
 *
 * `clipSec` is the chunk's true length, used to bound the returned timings. The model's segment END
 * times are markedly less reliable than its starts — it will occasionally hand back a two-word
 * segment spanning ten seconds — so ends are treated as advisory: each is capped by the following
 * segment's start, by the clip itself, and by a plausible per-word pace. Crucially, a segment's start
 * is floored by the previous segment's START rather than its END, so one overstated end cannot shove
 * every later segment forward and crush the remaining words into a fraction of a second.
 */
export async function transcribeChunk(
  key: string,
  wav: Blob,
  offsetSec: number,
  clipSec: number
): Promise<{ words: Word[]; usage: UsageDelta }> {
  const audio = await blobToBase64(wav);
  const res = await fetch(url(TEXT_MODEL), {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text:
                'Transcribe this audio clip verbatim. The speech is Bahasa Indonesia and may include English terms. ' +
                'Break it into short segments, each one sentence or a natural spoken phrase. For every segment give the ' +
                'exact spoken text and its start and end time in SECONDS (decimals allowed) measured from the start of this clip. ' +
                'Do not translate. Do not add punctuation the speaker did not imply. Cover the entire clip in order.',
            },
            { inlineData: { mimeType: 'audio/wav', data: audio } },
          ],
        },
      ],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  start: { type: 'number' },
                  end: { type: 'number' },
                },
                required: ['text', 'start', 'end'],
              },
            },
          },
          required: ['segments'],
        },
      },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const { inputTokens, outputTokens, costUSD } = estimateCost(TEXT_MODEL, j.usageMetadata, 0);
  const usage: UsageDelta = { kind: 'transcribe', inputTokens, outputTokens, images: 0, costUSD };
  const raw = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const reason = j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason;
    throw new Error(reason ? `Transcription returned no text (${reason}).` : 'Transcription returned no text.');
  }
  let parsed: { segments?: Segment[] };
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch {
    throw new Error('Could not parse the transcript returned by Gemini.');
  }
  const segs = (parsed.segments ?? [])
    .filter((s) => s && String(s.text ?? '').trim())
    .map((seg) => ({
      toks: String(seg.text).trim().split(/\s+/).filter(Boolean),
      start: Number(seg.start),
      end: Number(seg.end),
    }))
    .filter((s) => s.toks.length > 0);

  // Pass 1 — make starts finite, ordered, and inside the clip. Anchoring on the previous START
  // (never its end) is what stops one bad segment from cascading into every segment after it.
  let prevStart = 0;
  for (const s of segs) {
    if (!isFinite(s.start)) s.start = prevStart;
    s.start = Math.min(Math.max(s.start, prevStart), clipSec);
    prevStart = s.start;
  }

  // Pass 2 — treat each end as advisory, bounded by the next start, the clip, and a sane word pace.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const hardEnd = i + 1 < segs.length ? segs[i + 1].start : clipSec;
    if (!isFinite(s.end) || s.end <= s.start) s.end = s.start + s.toks.length * FALLBACK_WORD_SEC;
    s.end = Math.min(s.end, hardEnd, s.start + s.toks.length * MAX_WORD_SEC);
    if (s.end <= s.start) s.end = Math.min(hardEnd, s.start + s.toks.length * FALLBACK_WORD_SEC);
  }

  const words: Word[] = [];
  // Rounding to ms can push a value back over the edge, so bound after rounding, not before.
  const maxT = offsetSec + clipSec;
  for (const s of segs) {
    const per = (s.end - s.start) / s.toks.length;
    s.toks.forEach((tk, i) => {
      words.push({
        w: tk,
        s: Math.min(maxT, Number((offsetSec + s.start + i * per).toFixed(3))),
        e: Math.min(maxT, Number((offsetSec + s.start + (i + 1) * per).toFixed(3))),
        ...(i === 0 ? { p: true } : {}),
      });
    });
  }
  return { words, usage };
}

/** Draft a short English image prompt from (possibly Indonesian) scene text. */
export async function draftPrompt(key: string, sceneText: string): Promise<{ prompt: string; usage: UsageDelta }> {
  const res = await fetch(url(TEXT_MODEL), {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({
      contents: [{ parts: [{ text: sceneText }] }],
      systemInstruction: {
        parts: [
          {
            text:
              'You write concise English prompts for AI image generation. Given a scene script from a narrated video ' +
              '(often in Indonesian), reply with ONE vivid visual prompt (max 35 words) describing an illustration for ' +
              'that scene. The image must contain no text, words, or lettering. Reply with the prompt only.',
          },
        ],
      },
      generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 200 },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const out = j.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? '')
    .join('')
    .trim();
  if (!out) throw new Error('Empty response from the model.');
  const { inputTokens, outputTokens, costUSD } = estimateCost(TEXT_MODEL, j.usageMetadata, 0);
  return { prompt: out, usage: { kind: 'prompt', inputTokens, outputTokens, images: 0, costUSD } };
}

interface ImageAttempt {
  model: string;
  modalities: string[];
  aspect: boolean;
}

/**
 * Ordered fallbacks: Gemini 3.1 Flash Image ("Nano Banana 2") first — its stable id, then its
 * preview alias in case an account only has preview access — then older Nano Banana generations
 * for API keys/projects without Gemini 3 access yet. Gemini 3.x image models reject image-only
 * output, so those two attempts always request TEXT+IMAGE.
 */
const IMAGE_ATTEMPTS: ImageAttempt[] = [
  { model: 'gemini-3.1-flash-image', modalities: ['TEXT', 'IMAGE'], aspect: true },
  { model: 'gemini-3.1-flash-image-preview', modalities: ['TEXT', 'IMAGE'], aspect: true },
  { model: 'gemini-2.5-flash-image', modalities: ['IMAGE'], aspect: true },
  { model: 'gemini-2.5-flash-image', modalities: ['TEXT', 'IMAGE'], aspect: false },
  { model: 'gemini-2.0-flash-preview-image-generation', modalities: ['TEXT', 'IMAGE'], aspect: false },
];

let cachedAttempt: ImageAttempt | null = null;

async function requestImage(key: string, prompt: string, a: ImageAttempt): Promise<{ blob: Blob; usage: UsageDelta }> {
  const generationConfig: Record<string, unknown> = { responseModalities: a.modalities };
  if (a.aspect) generationConfig.imageConfig = { aspectRatio: '16:9' };
  const res = await fetch(url(a.model), {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);
  if (!img) {
    const reason = j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason;
    throw new Error(reason ? `No image was returned (${reason}).` : 'No image data in the response.');
  }
  const { inputTokens, outputTokens, costUSD } = estimateCost(a.model, j.usageMetadata, 1);
  return {
    blob: base64ToBlob(img.inlineData.data, img.inlineData.mimeType || 'image/png'),
    usage: { kind: 'image', inputTokens, outputTokens, images: 1, costUSD },
  };
}

/** Generate a 16:9 illustration, trying image models/params in order and caching the first that works. */
export async function generateImage(key: string, prompt: string): Promise<{ blob: Blob; usage: UsageDelta }> {
  if (cachedAttempt) return requestImage(key, prompt, cachedAttempt);
  let lastErr: unknown;
  for (const a of IMAGE_ATTEMPTS) {
    try {
      const result = await requestImage(key, prompt, a);
      cachedAttempt = a;
      return result;
    } catch (e) {
      if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Image generation failed.');
}
