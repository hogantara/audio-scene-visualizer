# Audio Scene Visualizer

Turn a narrated audio recording (podcast episode, essay) into a preview-ready scene video: upload audio → automatic transcription with word-level timestamps → automatic scene chunking → an AI illustration per scene → synced full-episode playback. Local-first: everything (audio, transcript, scenes, images) lives in your browser's IndexedDB.

## Run it

```sh
npm install
npm run dev
```

Open http://localhost:5173.

## API key

The app uses **your own Google Gemini API key**, entered in-app (Settings, or the "Set API key" button on the start screen). It is stored only in this browser's localStorage and sent only to `generativelanguage.googleapis.com`. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). It powers:

- **Transcription** — `gemini-2.5-flash` transcribes the audio (Bahasa Indonesia + English) into timestamped phrase segments; word timings are interpolated within each segment (see the note below)
- **Prompt drafting** (optional) — `gemini-2.5-flash` turns a scene's script into an English image prompt
- **Image generation** — `gemini-3.1-flash-image` ("Nano Banana 2"), falling back automatically through its preview alias, then `gemini-2.5-flash-image` and `gemini-2.0-flash-preview-image-generation` (original "Nano Banana"), for keys/projects without Gemini 3 access yet

### A note on timestamp accuracy

Whisper-class models give true per-word timestamps; Gemini returns timestamps at the phrase/sentence level. This app asks Gemini for phrase segments with start/end times and then spreads word timings evenly within each phrase. In practice **phrase-level caption sync is good**, but the per-word karaoke highlight inside a phrase is approximate rather than measured. If you later need tighter word-level sync, the transcription layer (`src/lib/gemini.ts`) is isolated and can be pointed at a Whisper endpoint without touching the rest of the app.

## How it works

- Audio (mp3/wav/m4a, ≤60 min / ≤500 MB) is decoded in-browser to 16 kHz mono and split into ≤10-minute chunks at the quietest point near each boundary (Whisper's 25 MB upload cap). Each chunk's transcript is saved as it completes, so a failed transcription **resumes where it stopped** on retry.
- Scenes are cut at sentence ends, pauses (≥0.7 s), and Whisper segment boundaries, targeting 10–30 s each. Scene boundaries always tile the full audio — no gaps or overlaps.
- Scene editing: merge with next, split at any word (word timestamps preserved), edit on-screen text freely (never shifts audio timing).
- **Caption-crowding split**: a scene whose caption can only be auto-fitted below a comfortable size (3.6% of frame width), or that wraps past 5 lines, is split in two at the nearest sentence boundary — falling back to a clause boundary or a real pause, and refusing to cut a long unbroken sentence at all (that scene is flagged in the editor instead). Runs automatically after a storyboard import and on demand from **Fix crowding** in the scene list; both halves keep the beat's artwork and image brief, and it's one undo step.
- Each scene has an editable image prompt pre-filled from its script; a project-wide style descriptor is appended to every prompt. Generate per scene, "Generate all" with a stop button, regenerate, or upload your own image.
- Playback: 16:9 stage with the scene's illustration (or a placeholder), captions revealed line-by-line with word-level highlight, seek bar with scene ticks, per-scene jump and per-scene preview.
- Subtitles: pick a project-wide font (Sans, **Cormorant**, Playfair Display, Montserrat, Bebas Neue) and drag the subtitle anywhere in the preview (defaults to center). Text has no background box — just a contrast shadow.
- **Export to MP4** (1920×1080): renders the whole episode to a Full-HD video that matches the preview exactly — image cover-fit, scrim, subtitle font/position, and karaoke timing — muxed with the audio. Prefers H.264/AAC MP4 and falls back to WebM only if the browser can't record MP4.
- Autosave: every change is persisted to IndexedDB ~0.5 s after it happens; reopening the app restores the project.
- **Undo/redo** (⌘Z / ⌘⇧Z, or the ↶ ↷ buttons in the top bar): covers text and prompt edits, scene merges/splits, image generation/regeneration/upload, and every style control (font, colors, brightness, subtitle size, karaoke). Rapid edits to the same field — typing, dragging a slider — collapse into one undo step instead of one per keystroke. History resets when you start or discard a project and doesn't survive a page reload. Regenerating or replacing a scene's image keeps the old one around just long enough for undo to restore it, then reclaims the storage once it's no longer reachable.
- Other shortcuts (see the ⌨ button in the top bar): **Space** play/pause, **←/→** previous/next scene, **⌘S** save now, **Esc** close dialogs. Space/arrows are ignored while typing in a text field.

### How export works (and its one caveat)

Export uses the browser's `MediaRecorder`: each frame is drawn to a 1920×1080 canvas with the same rendering code as the preview, captured alongside the audio, and recorded. Because it records the live stream, **it runs in real time** (a 15-min episode takes ~15 min) and the tab should stay in the foreground. Audio/video stay in sync automatically since both are recorded as one stream. Recording starts the moment audio actually begins playing, so there's no dead lead-in; on browsers with unusually high audio-start latency the very first ~100–200 ms of the opening can be trimmed.

## Not in this version (per PRD, P2)

- Ken Burns motion on stills, vertical (9:16) export, direct YouTube upload, multi-speaker labeling
