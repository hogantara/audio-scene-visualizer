import { create } from 'zustand';
import type { CaptionEntrance, CaptionPos, CaptionStyle, Project, Scene } from './types';
import { EMPTY_USAGE } from './types';
import {
  DEFAULT_FONT,
  DEFAULT_HIGHLIGHT,
  DEFAULT_BG_BRIGHTNESS,
  DEFAULT_CAPTION_SCALE,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_CAPTION_ENTRANCE,
  font,
  loadCaptionFont,
} from './lib/fonts';
import { makeMeasure } from './lib/caption';
import { autoSplitCrowded, countCrowded } from './lib/crowding';
import type { CrowdingResult } from './lib/crowding';
import * as db from './lib/db';
import type { ProjectSummary } from './lib/db';
import { decodeAudio, computePeaks, validateFile, planChunks, encodeWavSlice, MAX_DURATION_SEC, DecodedAudio } from './lib/audio';
import { transcribeChunk, generateImage, draftPrompt } from './lib/gemini';
import type { UsageDelta } from './lib/gemini';
import {
  alignBeats,
  buildScenes,
  buildFinalPrompt,
  defaultPrompt,
  mergeWithNext,
  splitScene,
  clampWordsToDuration,
} from './lib/scenes';
import type { StoryboardSection } from './lib/storyboard';

const API_KEY_STORAGE = 'asv_gemini_key';
const uid = () => crypto.randomUUID();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Decoded PCM cache — heavy, so kept outside the store and rebuilt on demand. */
let decoded: DecodedAudio | null = null;
let saveTimer: number | undefined;
let toastTimer: number | undefined;

/** Undo history depth. Each entry is a full project snapshot, so this stays modest. */
const HISTORY_LIMIT = 30;
/** Rapid edits to the same field (typing, dragging a slider) within this window collapse into one undo step. */
const COALESCE_MS = 700;
let lastEditKey: string | null = null;
let lastEditAt = 0;

export interface SeekRequest {
  t: number;
  play?: boolean;
  stopAt?: number;
  nonce: number;
}

/** Outcome of matching a folder of artwork against the scenes' storyboard asset names. */
export interface StoryboardImageResult {
  /** Scenes that got an image. */
  matched: number;
  /** Scenes that named an asset. `matched` out of this many. */
  total: number;
  /** Asset names no file in the folder matched — usually a rename, so worth showing. */
  missing: string[];
}

/**
 * Keys a filename can be matched under, most to least specific. The loose key drops the extension
 * and every non-alphanumeric character, which is what lets a storyboard's hand-typed name reach the
 * real file despite punctuation drift — including the `..._golden_hou[r]_...jpeg` typo in the Sirah
 * storyboard, whose brackets simply vanish on both sides.
 */
function assetKeys(name: string): string[] {
  const base = name.trim().replace(/^.*[/\\]/, '');
  const lower = base.toLowerCase();
  const stem = lower.replace(/\.[a-z0-9]{1,5}$/, '');
  return [base, lower, stem.replace(/[^a-z0-9]/g, '')];
}

/** An audio span the player repeats indefinitely — used to audition one word's timing. */
export interface LoopRegion {
  from: number;
  to: number;
}

interface State {
  phase: 'loading' | 'empty' | 'ready';
  project: Project | null;
  /** Saved projects other than the one currently open, for the reopen/delete library. */
  projects: ProjectSummary[];
  audioUrl: string | null;
  imageUrls: Record<string, string>;
  apiKey: string;
  selectedSceneId: string | null;
  activeSceneId: string | null;
  seekRequest: SeekRequest | null;
  loopRegion: LoopRegion | null;
  uploadBusy: boolean;
  uploadError: string | null;
  transcribing: boolean;
  transcribeStatus: string | null;
  transcribeError: string | null;
  queueActive: boolean;
  settingsOpen: boolean;
  exportOpen: boolean;
  savedAt: number | null;
  toastMsg: string | null;
  historyPast: Project[];
  historyFuture: Project[];

  init: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  createProject: (file: File) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  backToLibrary: () => void;
  deleteProject: (id: string) => Promise<void>;
  setApiKey: (k: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setName: (name: string) => void;
  setStyle: (style: string) => void;
  setCaptionFont: (font: string) => void;
  setCaptionPos: (pos: CaptionPos) => void;
  setHighlightColor: (color: string) => void;
  setBgBrightness: (v: number) => void;
  setCaptionScale: (v: number) => void;
  setCaptionStyle: (v: CaptionStyle) => void;
  setCaptionEntrance: (v: CaptionEntrance) => void;
  /** Shift one transcript word's karaoke timing by `delta` seconds. `index` is absolute into `words`. */
  nudgeWord: (index: number, delta: number) => void;
  resetWordOffset: (index: number) => void;
  /**
   * Shift a displayed word that has no transcript match (added/reworded — see sceneWordOffsets).
   * `word` is the word's BASE [s, e] span (WordSpec.baseStart/baseEnd — its timing before any
   * correction), used to bound the nudge by the audio.
   */
  nudgeSceneWord: (sceneId: string, key: string, delta: number, word: { s: number; e: number }) => void;
  resetSceneWordOffset: (sceneId: string, key: string) => void;
  setLoopRegion: (region: LoopRegion | null) => void;
  resetUsage: () => void;
  startTranscription: () => Promise<void>;
  selectScene: (id: string | null) => void;
  setActiveScene: (id: string | null) => void;
  requestSeek: (t: number, opts?: { play?: boolean; stopAt?: number }) => void;
  updateSceneText: (id: string, text: string) => void;
  updateScenePrompt: (id: string, prompt: string) => void;
  mergeSceneWithNext: (id: string) => void;
  splitSceneAt: (id: string, relIndex: number) => void;
  generateSceneImage: (id: string) => Promise<void>;
  draftScenePrompt: (id: string) => Promise<void>;
  uploadSceneImage: (id: string, file: File) => Promise<void>;
  reuseSceneImage: (id: string, sourceImageId: string) => void;
  /**
   * Replace the scene list with one storyboard section's beats, aligned to the transcript.
   * Returns how many scenes were created and how many need a timing check.
   */
  importStoryboard: (section: StoryboardSection) => { scenes: number; needsReview: number };
  /**
   * Split every scene whose caption is too crowded to read comfortably (see lib/crowding), marking
   * any that can't be split safely for a human. Runs after a storyboard import and on demand from
   * the scene list. Its own undo step, so the splitting can be reversed without losing the import.
   */
  fixCrowding: () => Promise<CrowdingResult>;
  /**
   * Attach images to imported scenes by matching filenames against their `assetName`. Takes a whole
   * folder's worth of files; non-images and files no scene asked for are ignored.
   */
  attachStoryboardImages: (files: File[]) => Promise<StoryboardImageResult>;
  generateAllMissing: () => Promise<void>;
  stopQueue: () => void;
  toast: (msg: string) => void;
  undo: () => void;
  redo: () => void;
  saveNow: () => void;
}

export const useStore = create<State>((set, get) => {
  const persist = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const p = get().project;
      if (!p) return;
      await db.saveProject(p);
      set({ savedAt: Date.now() });
    }, 500);
  };

  /**
   * All project mutations go through here: clone → mutate → set → autosave.
   *
   * `coalesceKey` groups rapid-fire edits (typing, dragging a slider) into a single undo step by
   * skipping the history push when the same key was just edited within COALESCE_MS — otherwise
   * every keystroke or slider tick would be its own undo entry.
   *
   * `silent` skips history entirely, for internal bookkeeping (transcription progress, in-flight
   * image-generation status) that isn't something a user would think of as an edit to undo.
   */
  const mutate = (fn: (p: Project) => void, opts?: { coalesceKey?: string; silent?: boolean }) => {
    const p = get().project;
    if (!p) return;
    if (!opts?.silent) {
      const now = Date.now();
      const key = opts?.coalesceKey ?? null;
      const coalescing = key !== null && key === lastEditKey && now - lastEditAt < COALESCE_MS;
      if (!coalescing) {
        set((st) => ({
          historyPast: [...st.historyPast, p].slice(-HISTORY_LIMIT),
          historyFuture: [],
        }));
      } else if (get().historyFuture.length > 0) {
        set({ historyFuture: [] });
      }
      lastEditKey = key;
      lastEditAt = now;
    }
    const copy = structuredClone(p);
    fn(copy);
    copy.updatedAt = Date.now();
    set({ project: copy });
    persist();
    if (!opts?.silent) gcImages();
  };

  const findScene = (p: Project, id: string): Scene | undefined => p.scenes.find((s) => s.id === id);

  const addImageUrl = (id: string, blob: Blob) => {
    set((st) => ({ imageUrls: { ...st.imageUrls, [id]: URL.createObjectURL(blob) } }));
  };

  const dropImage = async (id: string) => {
    const url = get().imageUrls[id];
    if (url) URL.revokeObjectURL(url);
    set((st) => {
      const next = { ...st.imageUrls };
      delete next[id];
      return { imageUrls: next };
    });
    await db.deleteImage(id);
  };

  /** Every image id still reachable from the current project or the undo/redo stacks — anything else is safe to delete. */
  const collectReferencedImageIds = (): Set<string> => {
    const ids = new Set<string>();
    const add = (proj: Project | null | undefined) => {
      if (!proj) return;
      for (const s of proj.scenes) if (s.imageId) ids.add(s.imageId);
    };
    const st = get();
    add(st.project);
    st.historyPast.forEach(add);
    st.historyFuture.forEach(add);
    return ids;
  };

  /**
   * Reclaim image blobs that fell out of every undo/redo snapshot. Replacing or merging away an
   * image doesn't delete its blob immediately — undo needs it — so this runs after every historized
   * mutation to clean up once a snapshot referencing it finally ages out of the history window.
   */
  const gcImages = () => {
    const referenced = collectReferencedImageIds();
    const st = get();
    Object.keys(st.imageUrls)
      .filter((id) => !referenced.has(id))
      .forEach((id) => void dropImage(id).catch(() => {}));
  };

  /** Attach an image blob to a scene. Any image it replaces is left in place for undo; gcImages reclaims it once unreachable. */
  const attachImage = async (sceneId: string, blob: Blob) => {
    const imgId = uid();
    await db.saveImage(imgId, blob);
    const stillExists = get().project && findScene(get().project!, sceneId);
    if (!stillExists) {
      await db.deleteImage(imgId);
      return;
    }
    addImageUrl(imgId, blob);
    mutate((p) => {
      const s = findScene(p, sceneId);
      if (!s) return;
      s.imageId = imgId;
      s.imageStatus = 'ready';
      s.imageError = undefined;
    });
  };

  /** Accumulate one API call's usage/cost onto the project. Bookkeeping, not a user edit — silent. */
  const recordUsage = (u: UsageDelta) =>
    mutate(
      (p) => {
        if (u.kind === 'transcribe') p.usage.transcribeCalls++;
        if (u.kind === 'prompt') p.usage.promptCalls++;
        if (u.kind === 'image') {
          p.usage.imageCalls++;
          p.usage.imagesGenerated += u.images;
        }
        p.usage.inputTokens += u.inputTokens;
        p.usage.outputTokens += u.outputTokens;
        p.usage.costUSD += u.costUSD;
      },
      { silent: true }
    );

  return {
    phase: 'loading',
    project: null,
    projects: [],
    audioUrl: null,
    imageUrls: {},
    apiKey: localStorage.getItem(API_KEY_STORAGE) ?? '',
    selectedSceneId: null,
    activeSceneId: null,
    seekRequest: null,
    loopRegion: null,
    uploadBusy: false,
    uploadError: null,
    transcribing: false,
    transcribeStatus: null,
    transcribeError: null,
    queueActive: false,
    settingsOpen: false,
    exportOpen: false,
    savedAt: null,
    toastMsg: null,
    historyPast: [],
    historyFuture: [],

    init: async () => {
      await get().refreshProjects();
      const lastId = await db.loadLastOpenId();
      if (lastId) {
        await get().openProject(lastId);
      } else {
        set({ phase: 'empty' });
      }
    },

    refreshProjects: async () => {
      const projects = await db.listProjects();
      set({ projects });
    },

    openProject: async (id) => {
      set({ phase: 'loading' });
      const project = await db.loadProject(id);
      if (!project) {
        set({ phase: 'empty' });
        get().toast('That project could not be found — it may have already been deleted.');
        await get().refreshProjects();
        return;
      }
      // Migrate projects saved before caption font/position/highlight existed.
      if (!project.captionFont) project.captionFont = DEFAULT_FONT;
      if (!project.captionPos) project.captionPos = { x: 0.5, y: 0.5 };
      if (!project.highlightColor) project.highlightColor = DEFAULT_HIGHLIGHT;
      if (project.bgBrightness === undefined || project.bgBrightness === null) {
        project.bgBrightness = DEFAULT_BG_BRIGHTNESS;
      }
      if (project.captionScale === undefined || project.captionScale === null) {
        project.captionScale = DEFAULT_CAPTION_SCALE;
      } else if (project.captionScale > 1) {
        // The subtitle no longer scales above 100%; pull any older, larger value back to the ceiling.
        project.captionScale = 1;
      }
      if (!project.captionStyle) {
        // Migrate from the old boolean: karaoke off meant a static caption, on meant the highlight sweep.
        const legacy = (project as { karaokeEnabled?: boolean }).karaokeEnabled;
        project.captionStyle = legacy === false ? 'static' : DEFAULT_CAPTION_STYLE;
        delete (project as { karaokeEnabled?: boolean }).karaokeEnabled;
      }
      if (!project.captionEntrance) project.captionEntrance = DEFAULT_CAPTION_ENTRANCE;
      if (!project.wordOffsets) project.wordOffsets = {};
      if (!project.sceneWordOffsets) project.sceneWordOffsets = {};
      if (!project.usage) project.usage = { ...EMPTY_USAGE };
      if (!project.updatedAt) project.updatedAt = project.createdAt;
      // Fix up projects transcribed before word timestamps were clamped to the audio's real length —
      // a word whose onset fell past the end could never reach its karaoke/word-reveal moment.
      if (project.words.length > 0) clampWordsToDuration(project.words, project.duration);

      // Switching away from whatever was previously open: release its blob URLs and cached PCM.
      const prev = get();
      if (prev.audioUrl) URL.revokeObjectURL(prev.audioUrl);
      Object.values(prev.imageUrls).forEach((u) => URL.revokeObjectURL(u));
      decoded = null;
      lastEditKey = null;
      lastEditAt = 0;

      const audio = await db.loadAudio(id);
      const imageUrls: Record<string, string> = {};
      for (const s of project.scenes) {
        // Recover from a session that closed mid-generation.
        if (s.imageStatus === 'generating') s.imageStatus = s.imageId ? 'ready' : 'none';
        if (s.imageId) {
          const blob = await db.loadImage(s.imageId);
          if (blob) {
            imageUrls[s.imageId] = URL.createObjectURL(blob);
          } else {
            s.imageId = null;
            s.imageStatus = 'none';
          }
        }
      }
      await db.saveLastOpenId(id);
      set({
        phase: 'ready',
        project,
        audioUrl: audio ? URL.createObjectURL(audio) : null,
        imageUrls,
        selectedSceneId: project.scenes[0]?.id ?? null,
        activeSceneId: null,
        seekRequest: null,
        loopRegion: null,
        transcribeError: null,
        uploadError: null,
        historyPast: [],
        historyFuture: [],
        savedAt: null,
      });
    },

    backToLibrary: () => {
      const { audioUrl, imageUrls } = get();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      Object.values(imageUrls).forEach((u) => URL.revokeObjectURL(u));
      decoded = null;
      lastEditKey = null;
      lastEditAt = 0;
      void db.clearLastOpenId();
      set({
        phase: 'empty',
        project: null,
        audioUrl: null,
        imageUrls: {},
        selectedSceneId: null,
        activeSceneId: null,
        seekRequest: null,
        transcribeError: null,
        uploadError: null,
        historyPast: [],
        historyFuture: [],
        savedAt: null,
      });
      void get().refreshProjects();
    },

    deleteProject: async (id) => {
      const isOpen = get().project?.id === id;
      const target = isOpen ? get().project : await db.loadProject(id);
      const imageIds = target ? target.scenes.map((s) => s.imageId).filter((x): x is string => !!x) : [];
      await db.deleteProjectCompletely(id, imageIds);
      if (isOpen) {
        const { audioUrl, imageUrls } = get();
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        Object.values(imageUrls).forEach((u) => URL.revokeObjectURL(u));
        decoded = null;
        lastEditKey = null;
        lastEditAt = 0;
        await db.clearLastOpenId();
        set({
          phase: 'empty',
          project: null,
          audioUrl: null,
          imageUrls: {},
          selectedSceneId: null,
          activeSceneId: null,
          seekRequest: null,
          transcribeError: null,
          uploadError: null,
          historyPast: [],
          historyFuture: [],
          savedAt: null,
        });
      }
      await get().refreshProjects();
    },

    createProject: async (file) => {
      set({ uploadBusy: true, uploadError: null });
      const invalid = validateFile(file);
      if (invalid) {
        set({ uploadBusy: false, uploadError: invalid });
        return;
      }
      try {
        decoded = await decodeAudio(file);
      } catch {
        set({
          uploadBusy: false,
          uploadError: 'Could not decode this audio file — it may be corrupted or use an unsupported codec.',
        });
        return;
      }
      if (decoded.duration > MAX_DURATION_SEC) {
        const min = Math.round(decoded.duration / 60);
        decoded = null;
        set({ uploadBusy: false, uploadError: `This recording is ${min} minutes long — the limit is 60 minutes.` });
        return;
      }
      const id = uid();
      const now = Date.now();
      const project: Project = {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        createdAt: now,
        updatedAt: now,
        audioName: file.name,
        duration: decoded.duration,
        peaks: computePeaks(decoded.samples),
        style: '',
        captionFont: DEFAULT_FONT,
        captionPos: { x: 0.5, y: 0.5 },
        highlightColor: DEFAULT_HIGHLIGHT,
        bgBrightness: DEFAULT_BG_BRIGHTNESS,
        captionScale: DEFAULT_CAPTION_SCALE,
        captionStyle: DEFAULT_CAPTION_STYLE,
        captionEntrance: DEFAULT_CAPTION_ENTRANCE,
        wordOffsets: {},
        sceneWordOffsets: {},
        words: [],
        scenes: [],
        chunks: null,
        transcribed: false,
        usage: { ...EMPTY_USAGE },
      };
      await db.saveAudio(id, file);
      await db.saveProject(project);
      await db.saveLastOpenId(id);
      lastEditKey = null;
      lastEditAt = 0;
      set({
        phase: 'ready',
        project,
        audioUrl: URL.createObjectURL(file),
        uploadBusy: false,
        savedAt: Date.now(),
        historyPast: [],
        historyFuture: [],
      });
      void get().refreshProjects();
    },

    setApiKey: (k) => {
      localStorage.setItem(API_KEY_STORAGE, k.trim());
      set({ apiKey: k.trim() });
    },

    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setExportOpen: (open) => set({ exportOpen: open }),
    setName: (name) => mutate((p) => void (p.name = name), { coalesceKey: 'name' }),
    setStyle: (style) => mutate((p) => void (p.style = style), { coalesceKey: 'style' }),
    setCaptionFont: (font) => mutate((p) => void (p.captionFont = font)),
    setCaptionPos: (pos) => mutate((p) => void (p.captionPos = pos)),
    setHighlightColor: (color) => mutate((p) => void (p.highlightColor = color), { coalesceKey: 'highlightColor' }),
    setBgBrightness: (v) =>
      mutate((p) => void (p.bgBrightness = Math.min(1, Math.max(0, v))), { coalesceKey: 'bgBrightness' }),
    setCaptionScale: (v) =>
      mutate((p) => void (p.captionScale = Math.min(1, Math.max(0.5, v))), { coalesceKey: 'captionScale' }),
    setCaptionStyle: (v) => mutate((p) => void (p.captionStyle = v)),
    setCaptionEntrance: (v) => mutate((p) => void (p.captionEntrance = v)),

    // Repeated nudges of the same word coalesce into one undo step, so ⌘Z steps back to the word's
    // original timing rather than replaying every ±20 ms tap.
    nudgeWord: (index, delta) =>
      mutate(
        (p) => {
          const w = p.words[index];
          // No fixed ±cap: nudge as far as needed, bounded only by the audio itself. The bound is
          // on the word's START (the reveal moment the nudge controls) — clamping the end too would
          // silently refuse "Later" on a word that already touches the end of the clip.
          let next = (p.wordOffsets[index] ?? 0) + delta;
          if (w) next = Math.min(p.duration - w.s - 0.05, Math.max(-w.s, next));
          if (Math.abs(next) < 1e-4) delete p.wordOffsets[index];
          else p.wordOffsets[index] = Number(next.toFixed(3));
        },
        { coalesceKey: `nudge:${index}` }
      ),
    resetWordOffset: (index) => mutate((p) => void delete p.wordOffsets[index]),

    // Same shape as nudgeWord, for displayed words the transcript doesn't know about. Their base
    // time is interpolated then window-fitted (see buildWordLines), so the caller passes the
    // word's baseStart/baseEnd — the offset-0 reference the correction is measured from.
    nudgeSceneWord: (sceneId, key, delta, word) =>
      mutate(
        (p) => {
          if (!p.sceneWordOffsets) p.sceneWordOffsets = {};
          let next = (p.sceneWordOffsets[sceneId]?.[key] ?? 0) + delta;
          next = Math.min(p.duration - word.s - 0.05, Math.max(-word.s, next));
          if (Math.abs(next) < 1e-4) {
            const m = p.sceneWordOffsets[sceneId];
            if (m) {
              delete m[key];
              if (Object.keys(m).length === 0) delete p.sceneWordOffsets[sceneId];
            }
          } else {
            (p.sceneWordOffsets[sceneId] ??= {})[key] = Number(next.toFixed(3));
          }
        },
        { coalesceKey: `nudge:${sceneId}:${key}` }
      ),
    resetSceneWordOffset: (sceneId, key) =>
      mutate((p) => {
        const m = p.sceneWordOffsets?.[sceneId];
        if (!m) return;
        delete m[key];
        if (Object.keys(m).length === 0) delete p.sceneWordOffsets[sceneId];
      }),
    setLoopRegion: (region) => set({ loopRegion: region }),
    resetUsage: () => mutate((p) => void (p.usage = { ...EMPTY_USAGE }), { silent: true }),

    startTranscription: async () => {
      const { apiKey, project, transcribing } = get();
      if (!project || transcribing) return;
      if (!apiKey) {
        set({ settingsOpen: true });
        get().toast('Add your Gemini API key to transcribe.');
        return;
      }
      set({ transcribing: true, transcribeError: null, transcribeStatus: 'Preparing audio…' });
      try {
        if (!decoded) {
          const audio = await db.loadAudio(project.id);
          if (!audio) throw new Error('The audio file is missing from local storage. Start a new project.');
          decoded = await decodeAudio(audio);
        }
        if (!get().project!.chunks) {
          const chunks = planChunks(decoded.samples, decoded.sampleRate);
          mutate((p) => void (p.chunks = chunks), { silent: true });
        }
        const total = get().project!.chunks!.length;
        for (let i = 0; i < total; i++) {
          if (get().project!.chunks![i].words) continue;
          set({ transcribeStatus: total > 1 ? `Transcribing part ${i + 1} of ${total}…` : 'Transcribing…' });
          const c = get().project!.chunks![i];
          const wav = encodeWavSlice(decoded.samples, decoded.sampleRate, c.startSec, c.endSec);
          const { words, usage } = await transcribeChunk(apiKey, wav, c.startSec, c.endSec - c.startSec);
          mutate((p) => void (p.chunks![i].words = words), { silent: true });
          recordUsage(usage);
        }
        set({ transcribeStatus: 'Building scenes…' });
        const words = get().project!.chunks!.flatMap((c) => c.words!);
        if (words.length === 0) throw new Error('No speech was detected in this audio.');
        clampWordsToDuration(words, get().project!.duration);
        const scenes = buildScenes(words, get().project!.duration);
        // Silent: this is the one-time "finish setup" step, not an edit — undo shouldn't be
        // the way back to the pre-transcription screen (retry-transcription covers that).
        mutate(
          (p) => {
            p.words = words;
            p.scenes = scenes;
            p.transcribed = true;
          },
          { silent: true }
        );
        set({ selectedSceneId: scenes[0].id });
      } catch (e) {
        set({ transcribeError: errMsg(e) });
      } finally {
        set({ transcribing: false, transcribeStatus: null });
      }
    },

    selectScene: (id) => set({ selectedSceneId: id }),
    setActiveScene: (id) => set({ activeSceneId: id }),

    requestSeek: (t, opts) => set({ seekRequest: { t, ...opts, nonce: Date.now() + Math.random() } }),

    updateSceneText: (id, text) =>
      mutate(
        (p) => {
          const s = findScene(p, id);
          if (s) s.text = text;
        },
        { coalesceKey: `text:${id}` }
      ),

    updateScenePrompt: (id, prompt) =>
      mutate(
        (p) => {
          const s = findScene(p, id);
          if (s) s.prompt = prompt;
        },
        { coalesceKey: `prompt:${id}` }
      ),

    mergeSceneWithNext: (id) => {
      // Any image the merge orphans is left in place — gcImages reclaims it once undo can no
      // longer reach it — so the merge stays reversible.
      mutate((p) => {
        const i = p.scenes.findIndex((s) => s.id === id);
        if (i < 0 || i >= p.scenes.length - 1) return;
        const next = p.scenes[i + 1];
        if (get().selectedSceneId === next.id) set({ selectedSceneId: id });
        mergeWithNext(p, i);
      });
    },

    splitSceneAt: (id, relIndex) =>
      mutate((p) => {
        const i = p.scenes.findIndex((s) => s.id === id);
        if (i >= 0) splitScene(p, i, relIndex);
      }),

    generateSceneImage: async (id) => {
      const { apiKey, project } = get();
      if (!project) return;
      if (!apiKey) {
        set({ settingsOpen: true });
        get().toast('Add your Gemini API key to generate images.');
        return;
      }
      const scene = findScene(project, id);
      if (!scene || scene.imageStatus === 'generating') return;
      const finalPrompt = buildFinalPrompt(scene.prompt.trim() || defaultPrompt(scene.text), project.style);
      // Silent: an in-flight/failed status isn't user content — only the resulting image (attachImage) is undoable.
      mutate(
        (p) => {
          const s = findScene(p, id);
          if (!s) return;
          s.imageStatus = 'generating';
          s.imageError = undefined;
        },
        { silent: true }
      );
      try {
        const { blob, usage } = await generateImage(apiKey, finalPrompt);
        recordUsage(usage);
        await attachImage(id, blob);
      } catch (e) {
        mutate(
          (p) => {
            const s = findScene(p, id);
            if (!s) return;
            s.imageStatus = s.imageId ? 'ready' : 'error';
            s.imageError = errMsg(e);
          },
          { silent: true }
        );
      }
    },

    draftScenePrompt: async (id) => {
      const { apiKey, project } = get();
      if (!project) return;
      if (!apiKey) {
        set({ settingsOpen: true });
        get().toast('Add your Gemini API key first.');
        return;
      }
      const scene = findScene(project, id);
      if (!scene) return;
      try {
        const { prompt, usage } = await draftPrompt(apiKey, scene.text);
        recordUsage(usage);
        mutate((p) => {
          const s = findScene(p, id);
          if (s) s.prompt = prompt;
        });
      } catch (e) {
        get().toast(`Could not draft a prompt: ${errMsg(e)}`);
      }
    },

    uploadSceneImage: async (id, file) => {
      if (!file.type.startsWith('image/')) {
        get().toast('That file is not an image.');
        return;
      }
      await attachImage(id, file);
    },

    // Points the scene at an image blob that's already stored (from another scene) instead of
    // saving a new copy — multiple scenes can reference the same imageId; gcImages already
    // treats any scene's imageId as a live reference, so this needs no extra bookkeeping.
    reuseSceneImage: (id, sourceImageId) => {
      if (!get().imageUrls[sourceImageId]) return;
      mutate((p) => {
        const s = findScene(p, id);
        if (!s) return;
        s.imageId = sourceImageId;
        s.imageStatus = 'ready';
        s.imageError = undefined;
      });
    },

    importStoryboard: (section) => {
      const none = { scenes: 0, needsReview: 0 };
      const project = get().project;
      if (!project) return none;
      if (!project.transcribed || project.words.length === 0) {
        get().toast('Transcribe the audio first — the storyboard is matched against its words.');
        return none;
      }
      const { scenes, unaligned } = alignBeats(section.beats, project.words, project.duration);
      if (scenes.length === 0) {
        get().toast('None of the storyboard beats could be applied to this audio.');
        return none;
      }
      // Historized on purpose: unlike transcription this replaces work you may already have done,
      // so undo has to be the way back.
      mutate((p) => {
        p.scenes = scenes;
        // Displayed-word timing corrections are keyed by scene id, and every imported scene is a
        // new object with a new id, so the old entries can no longer find their words. Corrections
        // in `wordOffsets` are keyed by ABSOLUTE word index and survive the import untouched —
        // hand-fixed transcript timing carries over to the new scenes for free.
        p.sceneWordOffsets = {};
      });
      // Images from the replaced scenes are left in place for undo; gcImages reclaims them once
      // those snapshots age out of the history window.
      set({ selectedSceneId: scenes[0].id, activeSceneId: null });
      return { scenes: scenes.length, needsReview: unaligned.length };
    },

    fixCrowding: async () => {
      const none: CrowdingResult = { split: 0, flagged: 0 };
      const project = get().project;
      if (!project || project.scenes.length === 0) return none;
      // Measuring in the fallback face would misjudge every caption, so wait for the real one.
      const f = font(project.captionFont);
      await loadCaptionFont(f);
      const measure = makeMeasure(f.family, f.weight, f.bold);
      if (countCrowded(project, measure) === 0 && !project.scenes.some((s) => s.crowded)) return none;

      let result = none;
      mutate((p) => {
        result = autoSplitCrowded(p, measure);
      });
      return result;
    },

    attachStoryboardImages: async (files) => {
      const project = get().project;
      if (!project) return { matched: 0, total: 0, missing: [] };
      const wanted = project.scenes.filter((s) => s.assetName);
      if (wanted.length === 0) return { matched: 0, total: 0, missing: [] };

      // A picked folder also holds video and stray files (the Sirah asset folder has an .mp4), so
      // only images are candidates. First file wins a key, so a duplicate name never silently
      // reassigns a scene that already resolved.
      const byKey = new Map<string, File>();
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        for (const k of assetKeys(f.name)) if (!byKey.has(k)) byKey.set(k, f);
      }

      const assigned: { sceneId: string; imgId: string; blob: File }[] = [];
      const missing: string[] = [];
      // Several scenes can name the same file — a caption-crowding split leaves both halves of one
      // beat pointing at its artwork — so each file is stored once and its id shared.
      const savedIds = new Map<File, string>();
      for (const s of wanted) {
        const file = assetKeys(s.assetName!)
          .map((k) => byKey.get(k))
          .find(Boolean);
        if (!file) {
          if (!missing.includes(s.assetName!)) missing.push(s.assetName!);
          continue;
        }
        let imgId = savedIds.get(file);
        if (!imgId) {
          imgId = uid();
          await db.saveImage(imgId, file);
          savedIds.set(file, imgId);
        }
        assigned.push({ sceneId: s.id, imgId, blob: file });
      }

      savedIds.forEach((imgId, blob) => addImageUrl(imgId, blob));
      // One mutation for the whole folder, so a bulk attach is a single undo step rather than one
      // per image. A scene deleted while the blobs were saving is simply skipped — gcImages
      // reclaims its orphaned blob.
      mutate((p) => {
        for (const a of assigned) {
          const s = findScene(p, a.sceneId);
          if (!s) continue;
          s.imageId = a.imgId;
          s.imageStatus = 'ready';
          s.imageError = undefined;
        }
      });
      return { matched: assigned.length, total: wanted.length, missing };
    },

    generateAllMissing: async () => {
      if (get().queueActive) return;
      if (!get().apiKey) {
        set({ settingsOpen: true });
        get().toast('Add your Gemini API key to generate images.');
        return;
      }
      set({ queueActive: true });
      try {
        while (get().queueActive) {
          const next = get().project?.scenes.find((s) => s.imageStatus === 'none' || s.imageStatus === 'error');
          if (!next) break;
          await get().generateSceneImage(next.id);
          const after = get().project?.scenes.find((s) => s.id === next.id);
          if (!after || after.imageStatus !== 'ready') break; // stop the queue on failure instead of looping
        }
      } finally {
        set({ queueActive: false });
      }
    },

    stopQueue: () => set({ queueActive: false }),

    toast: (msg) => {
      window.clearTimeout(toastTimer);
      set({ toastMsg: msg });
      toastTimer = window.setTimeout(() => set({ toastMsg: null }), 4500);
    },

    undo: () => {
      const { project, historyPast } = get();
      if (!project || historyPast.length === 0) return;
      const prev = historyPast[historyPast.length - 1];
      set((st) => ({
        project: prev,
        historyPast: st.historyPast.slice(0, -1),
        historyFuture: [...st.historyFuture, project].slice(-HISTORY_LIMIT),
        selectedSceneId:
          st.selectedSceneId && prev.scenes.some((s) => s.id === st.selectedSceneId)
            ? st.selectedSceneId
            : prev.scenes[0]?.id ?? null,
      }));
      lastEditKey = null;
      persist();
      gcImages();
    },

    redo: () => {
      const { project, historyFuture } = get();
      if (!project || historyFuture.length === 0) return;
      const next = historyFuture[historyFuture.length - 1];
      set((st) => ({
        project: next,
        historyFuture: st.historyFuture.slice(0, -1),
        historyPast: [...st.historyPast, project].slice(-HISTORY_LIMIT),
        selectedSceneId:
          st.selectedSceneId && next.scenes.some((s) => s.id === st.selectedSceneId)
            ? st.selectedSceneId
            : next.scenes[0]?.id ?? null,
      }));
      lastEditKey = null;
      persist();
      gcImages();
    },

    saveNow: () => {
      window.clearTimeout(saveTimer);
      const p = get().project;
      if (!p) {
        get().toast('Nothing to save yet.');
        return;
      }
      const updated = { ...p, updatedAt: Date.now() };
      set({ project: updated });
      db.saveProject(updated).then(() => {
        set({ savedAt: Date.now() });
        get().toast('Saved.');
      });
    },
  };
});
