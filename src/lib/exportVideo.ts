import type { Project } from '../types';
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
} from './caption';
import { computeSceneMix, edgeFadeAlpha, smoothstep, TRANSITION_SEC } from './transition';
import { sceneWords } from './scenes';
import { font, loadCaptionFont } from './fonts';

const W = 1920;
const H = 1080;
const FPS = 30;

/** Placeholder gradients — must match the `.ph-N` CSS classes used in the preview. */
const PLACEHOLDERS: [string, string][] = [
  ['#312e81', '#6d28d9'],
  ['#134e4a', '#0f766e'],
  ['#7c2d12', '#b45309'],
  ['#1e3a8a', '#0369a1'],
  ['#4a044e', '#9d174d'],
];

export interface ExportOptions {
  project: Project;
  imageUrls: Record<string, string>;
  audioUrl: string;
}

export interface ExportResult {
  blob: Blob;
  ext: string;
  /** True when the browser could not produce MP4 and fell back to WebM. */
  fallback: boolean;
}

interface MimeChoice {
  mime: string;
  ext: string;
  fallback: boolean;
}

function pickMime(): MimeChoice | null {
  const candidates: MimeChoice[] = [
    { mime: 'video/mp4;codecs=avc1.640029,mp4a.40.2', ext: 'mp4', fallback: false },
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', fallback: false },
    { mime: 'video/mp4', ext: 'mp4', fallback: false },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', fallback: true },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', fallback: true },
    { mime: 'video/webm', ext: 'webm', fallback: true },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mime)) ?? null;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Render the whole episode to a Full-HD MP4 whose frames replicate the in-app preview
 * (image cover-fit, scrim, and the synced caption in the chosen font and position), muxed
 * with the original audio. Recording happens in real time so A/V stays in sync.
 */
export async function exportVideo(
  opts: ExportOptions,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<ExportResult> {
  const { project, imageUrls, audioUrl } = opts;
  const choice = pickMime();
  if (!choice) throw new Error('This browser cannot record video.');
  if (project.scenes.length === 0) throw new Error('There are no scenes to export yet.');

  // Preload images and the caption font.
  const imgCache: Record<string, HTMLImageElement> = {};
  await Promise.all(
    Object.entries(imageUrls).map(async ([id, url]) => {
      const img = await loadImage(url);
      if (img) imgCache[id] = img;
    })
  );
  const f = font(project.captionFont);
  await loadCaptionFont(f);

  // Pre-compute each scene's caption layout once (fixed 1080p frame → font auto-fit is stable).
  const measure = makeMeasure(f.family, f.weight, f.bold);
  const layoutByScene: CaptionLayout[] = project.scenes.map((s) =>
    layoutCaption(buildWordLines(s.text, sceneWords(project, s), s.start, s.end, project.sceneWordOffsets?.[s.id]), {
      measure,
      maxWidth: W * CAPTION_MAX_WIDTH,
      maxHeight: H * CAPTION_MAX_HEIGHT,
      maxFontPx: W * MAX_FONT_FRACTION * project.captionScale,
      minFontPx: W * MIN_FONT_FRACTION * project.captionScale,
      lineHeightFactor: LINE_HEIGHT_FACTOR,
    })
  );

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Audio: route a fresh element through the graph so it feeds the recorded stream (silently).
  const ac = new AudioContext();
  await ac.resume();
  const audioEl = new Audio();
  audioEl.src = audioUrl;
  audioEl.preload = 'auto';
  await new Promise<void>((resolve, reject) => {
    audioEl.oncanplaythrough = () => resolve();
    audioEl.onerror = () => reject(new Error('Could not load the audio for export.'));
    audioEl.load();
  });
  const srcNode = ac.createMediaElementSource(audioEl);
  const destNode = ac.createMediaStreamDestination();
  srcNode.connect(destNode);

  const vStream = canvas.captureStream(FPS);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...destNode.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, {
    mimeType: choice.mime,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const teardown = () => {
    vStream.getTracks().forEach((t) => t.stop());
    destNode.stream.getTracks().forEach((t) => t.stop());
    audioEl.pause();
    ac.close().catch(() => {});
  };

  // Background: scene image (cover-fit) or placeholder gradient, drawn at a given opacity so
  // adjacent scenes can be crossfaded across the cut (matches the preview's elegant, slow fade).
  const drawSceneBg = (idx: number, alpha: number) => {
    const scene = project.scenes[idx];
    const img = scene?.imageId ? imgCache[scene.imageId] : null;
    ctx.globalAlpha = alpha;
    if (img) {
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      const [c1, c2] = PLACEHOLDERS[idx % 5];
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  };

  const drawFrame = (t: number) => {
    let si = project.scenes.findIndex((s) => t < s.end);
    if (si === -1) si = project.scenes.length - 1;

    const mix = computeSceneMix(project.scenes, t, si, TRANSITION_SEC);
    drawSceneBg(mix.a, 1);
    if (mix.b !== mix.a) drawSceneBg(mix.b, smoothstep(mix.mix));

    drawScrim(ctx, W, H, project.bgBrightness);

    // Caption — full scene text with markdown, line breaks, highlight marker, and the reveal style.
    drawCaptionLayout(ctx, {
      layout: layoutByScene[si],
      t,
      W,
      H,
      posX: project.captionPos.x,
      posY: project.captionPos.y,
      family: f.family,
      weightNormal: f.weight,
      weightBold: f.bold,
      highlightColor: project.highlightColor,
      style: project.captionStyle,
      entrance: project.captionEntrance,
    });

    // Open from black and close to black, matching the preview's intro/outro fade.
    const fade = edgeFadeAlpha(project.scenes, t, project.duration, TRANSITION_SEC);
    if (fade > 0) {
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  };

  const dur = project.duration;

  return new Promise<ExportResult>((resolve, reject) => {
    let raf = 0;
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* ignore */
      }
      teardown();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);

    recorder.onstop = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      teardown();
      resolve({ blob: new Blob(chunks, { type: choice.mime }), ext: choice.ext, fallback: choice.fallback });
    };
    recorder.onerror = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      teardown();
      reject(new Error('Recording failed.'));
    };

    const finish = () => {
      drawFrame(dur);
      onProgress(1);
      // Flush just the last frame, then stop; onstop resolves. Kept short to avoid trailing silence.
      setTimeout(() => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* ignore */
        }
      }, 70);
    };

    const loop = () => {
      if (finished) return;
      const t = audioEl.currentTime;
      drawFrame(Math.min(t, dur));
      onProgress(Math.min(1, t / dur));
      if (audioEl.ended || t >= dur - 0.03) {
        finish();
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    // Begin recording only once the audio is genuinely advancing, so the recorded timeline starts at
    // content t≈0 with no leading dead frame/silence. (On browsers with high audio-start latency this
    // trims a few hundred ms off the very opening; on normal browsers the offset is negligible.)
    const startSequence = async () => {
      drawFrame(0);
      await audioEl.play();
      await new Promise<void>((res) => {
        const check = () => {
          if (finished || audioEl.currentTime > 0.001) res();
          else requestAnimationFrame(check);
        };
        check();
      });
      if (finished) return;
      recorder.start(200);
      raf = requestAnimationFrame(loop);
    };

    startSequence().catch((err) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      teardown();
      reject(new Error('Could not start audio playback for export: ' + err.message));
    });
  });
}
