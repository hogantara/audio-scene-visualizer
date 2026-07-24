import type { Chunk } from '../types';

export const MAX_FILE_MB = 500;
export const MAX_DURATION_SEC = 60 * 60;
/**
 * Gemini's inline request payload is capped at ~20 MB. A WAV chunk is sent base64-encoded
 * (≈1.33× its bytes), so 6 min of 16 kHz mono 16-bit WAV (~11.5 MB → ~15.4 MB base64) stays safely under.
 */
const CHUNK_SEC = 360;
const TARGET_SR = 16000;

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

export function validateFile(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!['mp3', 'wav', 'm4a'].includes(ext)) {
    return `“.${ext || '?'}” files are not supported. Upload an mp3, wav, or m4a file.`;
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    return `This file is ${(file.size / 1e6).toFixed(0)} MB — the limit is ${MAX_FILE_MB} MB.`;
  }
  return null;
}

/** Decode any supported audio to 16 kHz mono PCM (compact for transcription upload; also used for the waveform). */
export async function decodeAudio(blob: Blob): Promise<DecodedAudio> {
  const buf = await blob.arrayBuffer();
  const ac = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ac.decodeAudioData(buf);
  } finally {
    ac.close();
  }
  const duration = decoded.duration;
  const off = new OfflineAudioContext(1, Math.ceil(duration * TARGET_SR), TARGET_SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: TARGET_SR, duration };
}

export function computePeaks(samples: Float32Array, buckets = 600): number[] {
  const per = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    const end = Math.min(samples.length, start + per);
    let max = 0;
    for (let i = start; i < end; i += 4) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const norm = Math.max(...peaks, 0.01);
  return peaks.map((p) => Number((p / norm).toFixed(3)));
}

/** Split the audio into ≤10-min transcription chunks, cutting at the quietest point near each boundary. */
export function planChunks(samples: Float32Array, sr: number): Chunk[] {
  const total = samples.length / sr;
  if (total <= CHUNK_SEC) return [{ startSec: 0, endSec: total, words: null }];
  const n = Math.ceil(total / CHUNK_SEC);
  const bounds = [0];
  for (let k = 1; k < n; k++) {
    bounds.push(quietestNear(samples, sr, (total * k) / n));
  }
  bounds.push(total);
  const chunks: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    chunks.push({ startSec: bounds[i], endSec: bounds[i + 1], words: null });
  }
  return chunks;
}

function quietestNear(samples: Float32Array, sr: number, target: number, windowSec = 5): number {
  const win = Math.floor(0.3 * sr);
  const step = Math.floor(0.05 * sr);
  const from = Math.max(0, Math.floor((target - windowSec) * sr));
  const to = Math.min(samples.length - win, Math.floor((target + windowSec) * sr));
  let best = target;
  let bestEnergy = Infinity;
  for (let i = from; i <= to; i += step) {
    let sum = 0;
    for (let j = i; j < i + win; j += 4) sum += Math.abs(samples[j]);
    if (sum < bestEnergy) {
      bestEnergy = sum;
      best = (i + win / 2) / sr;
    }
  }
  return best;
}

/** Encode a slice of mono PCM as a 16-bit WAV blob. */
export function encodeWavSlice(samples: Float32Array, sr: number, startSec: number, endSec: number): Blob {
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(samples.length, Math.ceil(endSec * sr));
  const len = end - start;
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  let o = 44;
  for (let i = start; i < end; i++, o += 2) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
