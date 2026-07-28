/**
 * Parser for the markdown storyboards written upstream of this app.
 *
 * A storyboard file describes one or more VO clips. Its own vocabulary does NOT line up with this
 * app's, and the mismatch matters:
 *
 *   `## Scene 1 — "Namaku Nadir…" (0:00–1:06, VO Sirah 1.1)`  →  one VO clip = one PROJECT
 *   a table row inside that section                            →  one `Scene` in this app
 *
 * So a single file typically covers several projects, and import applies one section to the
 * currently open project.
 *
 * Expected shape of a section:
 *
 *   ## Scene 1 — "Namaku Nadir bin Qais..." (0:00–1:06, VO Sirah 1.1)
 *
 *   Optional prose paragraph.
 *
 *   | # | Time | Narration (ID) | Asset | Why this image |
 *   |---|------|----------------|-------|----------------|
 *   | 1 | 0:00–0:03 | "Namaku Nadir bin Qais." | `Marketplace_….jpeg` | Establishing shot — … |
 *
 * Everything here is deliberately forgiving: these files are handwritten, and a storyboard that
 * fails to import is worse than one that imports with a couple of rows flagged for review.
 */

export interface StoryboardBeat {
  /** The "#" column, as authored. Falls back to the row's position when the cell isn't a number. */
  index: number;
  /** Seconds, parsed from the "Time" column. Estimates — used only as an alignment fallback. */
  tStart: number;
  tEnd: number;
  /** The beat's on-screen narration, quotes and markdown stripped. */
  narration: string;
  /** Filename from the "Asset" column, or null when no asset has been chosen for this beat. */
  assetName: string | null;
  /** The "Why this image" column — the authored image brief, used to prefill the scene's prompt. */
  rationale: string;
}

export interface StoryboardSection {
  /** Heading text with the leading "## " removed, e.g. `Scene 1 — "Namaku Nadir bin Qais..."`. */
  title: string;
  /** VO clip named in the heading parenthetical (`VO Sirah 1.1`), used to auto-pick a section. */
  vo: string | null;
  beats: StoryboardBeat[];
}

/**
 * Google Drive serves these files with markdown punctuation backslash-escaped (`\#`, `` \` ``,
 * `\*`, `\-`). A file saved locally has none of that. Both have to parse, so escapes are stripped
 * everywhere rather than only at line starts.
 */
function unescapeMd(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|~=<>"'])/g, '$1');
}

/** Strip the wrapping quotes the narration column uses, plus any inline emphasis markers. */
function cleanNarration(cell: string): string {
  let t = unescapeMd(cell).trim();
  // Ellipsis-continued fragments ("...siapa yang") keep their leading dots — they are part of the
  // authored line — so only paired quotes at both ends are removed.
  const pairs: [string, string][] = [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
  ];
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Matches the "(none — not yet generated)" / "(pending …)" placeholders used for unfilled cells. */
const PLACEHOLDER = /^\(?\s*(none|pending|tbd|n\/?a)\b/i;

/**
 * The asset filename, taken from the first backticked span in the cell. Placeholder cells and cells
 * with no backticks yield null — a beat with no image yet is normal (see the Scene 3 storyboard,
 * where every row is a generation brief).
 */
function parseAsset(cell: string): string | null {
  const raw = unescapeMd(cell).trim();
  const tick = raw.match(/`([^`]+)`/);
  const candidate = tick ? tick[1].trim() : raw.replace(/^\*+|\*+$/g, '').trim();
  if (!candidate || PLACEHOLDER.test(candidate)) return null;
  // Without a backtick the cell is only an asset if it actually reads as a filename; prose like
  // "hold the previous shot" must not become a phantom asset to match against.
  if (!tick && !/\.[a-z0-9]{2,5}$/i.test(candidate)) return null;
  return candidate;
}

function cleanRationale(cell: string): string {
  const t = unescapeMd(cell)
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .trim();
  return PLACEHOLDER.test(t) ? '' : t.replace(/\s+/g, ' ');
}

/** `1:06` → 66, `0:03` → 3, `1:02:03` → 3723. Returns NaN for anything unparseable. */
export function parseTimecode(s: string): number {
  const m = unescapeMd(s)
    .trim()
    .match(/(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?/);
  if (!m) return NaN;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] === undefined ? null : Number(m[3]);
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return (c === null ? a * 60 + b : a * 3600 + b * 60 + c) + frac;
}

/** Split a "0:19–0:22" range. Accepts en-dash, em-dash, hyphen, and "to". */
function parseRange(cell: string): { tStart: number; tEnd: number } {
  const parts = unescapeMd(cell).split(/\s*(?:[–—−-]|\bto\b)\s*/);
  const tStart = parseTimecode(parts[0] ?? '');
  const tEnd = parseTimecode(parts[1] ?? '');
  return { tStart, tEnd };
}

/**
 * Split a markdown table row into cells. A `\|` is a literal pipe inside a cell, so only unescaped
 * pipes separate. Leading/trailing delimiters produce empty edge cells, which are dropped.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

/** A `|---|:---:|---|` alignment row — the line that confirms the row above was a header. */
function isDivider(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(unescapeMd(c)));
}

/** Locate a column by header keyword, so column order can drift without breaking import. */
function findCol(headers: string[], ...keywords: string[]): number {
  for (const kw of keywords) {
    const i = headers.findIndex((h) => h.includes(kw));
    if (i !== -1) return i;
  }
  return -1;
}

function parseBeats(lines: string[]): StoryboardBeat[] {
  // Find the header row: any line followed by a divider row.
  let head = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && isDivider(lines[i + 1])) {
      head = i;
      break;
    }
  }
  if (head === -1) return [];

  const headers = splitRow(lines[head]).map((h) => unescapeMd(h).trim().toLowerCase());
  const cNum = findCol(headers, '#', 'no', 'beat');
  const cTime = findCol(headers, 'time', 'timecode', 'waktu');
  const cText = findCol(headers, 'narration', 'narasi', 'script', 'text', 'vo');
  const cAsset = findCol(headers, 'asset', 'image', 'visual', 'shot');
  const cWhy = findCol(headers, 'why', 'rationale', 'note', 'reason');
  // Narration is the only column the import genuinely cannot work without: it is what gets aligned
  // to the transcript and what ends up on screen.
  if (cText === -1) return [];

  const beats: StoryboardBeat[] = [];
  for (let i = head + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) break; // the table ended
    if (isDivider(line)) continue;
    const cells = splitRow(line);
    if (cells.length <= cText) continue;
    const narration = cleanNarration(cells[cText]);
    if (!narration) continue;
    const at = (c: number) => (c >= 0 && c < cells.length ? cells[c] : '');
    const { tStart, tEnd } = parseRange(at(cTime));
    const parsedNum = Number(unescapeMd(at(cNum)).trim());
    beats.push({
      index: Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : beats.length + 1,
      tStart,
      tEnd,
      narration,
      assetName: parseAsset(at(cAsset)),
      rationale: cleanRationale(at(cWhy)),
    });
  }
  return beats;
}

/** Pull `VO Sirah 1.1` out of a heading's parenthetical so a section can be matched to its audio. */
function parseVo(title: string): string | null {
  const m = title.match(/\bVO\s+([^),]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Parse a storyboard file into its sections. Sections with no beat table (the trailing
 * "## Notes / flags" block) are dropped, so the result is exactly the list of importable clips.
 */
export function parseStoryboard(md: string): StoryboardSection[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const headingAt: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Drive's escaped export writes the heading as `\#\# Scene 1`, so the backslash is optional
    // before EACH hash, not just the first.
    if (/^(?:\\?#){2}\s+\S/.test(lines[i])) headingAt.push(i);
  }
  const sections: StoryboardSection[] = [];
  for (let k = 0; k < headingAt.length; k++) {
    const start = headingAt[k];
    const end = k + 1 < headingAt.length ? headingAt[k + 1] : lines.length;
    const title = unescapeMd(lines[start].replace(/^(?:\\?#){2}\s+/, '')).trim();
    const beats = parseBeats(lines.slice(start + 1, end));
    if (beats.length === 0) continue;
    sections.push({ title, vo: parseVo(title), beats });
  }
  return sections;
}

/**
 * Score how well a section's heading matches an audio filename, for preselecting a section on
 * import. Compares the alphanumeric runs the two have in common (`Sirah 1.1` vs
 * `Sirah 1.1-esv2-50p-bg-10p-music-10p.wav`), so a VO reference matches its file without either
 * side needing to be exact. Higher is better; 0 means no evidence.
 */
export function scoreSectionForAudio(section: StoryboardSection, audioName: string): number {
  const hay = audioName.toLowerCase();
  const tokens = `${section.vo ?? ''} ${section.title}`
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 2);
  let score = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) continue;
    // A version-like token ("1.1") is far stronger evidence than a shared word ("sirah"), which
    // every section in an episode's storyboard has in common.
    score += /\d/.test(t) ? 3 : 1;
  }
  return score;
}
