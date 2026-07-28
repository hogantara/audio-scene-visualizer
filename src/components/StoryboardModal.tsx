import { useMemo, useRef, useState } from 'react';
import { FileText, FolderOpen, WarningCircle } from '@phosphor-icons/react';
import { useStore } from '../store';
import type { StoryboardImageResult } from '../store';
import { parseStoryboard, scoreSectionForAudio } from '../lib/storyboard';
import type { StoryboardSection } from '../lib/storyboard';
import { fmtTime } from '../lib/format';

/**
 * Import a markdown storyboard onto the open project.
 *
 * A storyboard file describes several VO clips — one `## Scene` section each — while the open
 * project is a single clip, so the first step is choosing which section applies here. The section
 * whose heading best matches the project's audio filename is preselected, since that is right
 * almost every time.
 */
export default function StoryboardModal({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)!;
  const importStoryboard = useStore((s) => s.importStoryboard);
  const attachStoryboardImages = useStore((s) => s.attachStoryboardImages);
  const toast = useStore((s) => s.toast);

  const [sections, setSections] = useState<StoryboardSection[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [chosen, setChosen] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [imported, setImported] = useState<{ scenes: number; needsReview: number } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attached, setAttached] = useState<StoryboardImageResult | null>(null);

  const mdInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    try {
      const found = parseStoryboard(await file.text());
      if (found.length === 0) {
        setParseError(
          'No storyboard beats found in that file. Each scene needs a "## …" heading followed by a table with a Narration column.'
        );
        return;
      }
      setFileName(file.name);
      setSections(found);
      // Preselect by matching the section heading's VO reference against this project's audio.
      let best = 0;
      let bestScore = -1;
      found.forEach((s, i) => {
        const score = scoreSectionForAudio(s, project.audioName);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      setChosen(best);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  };

  const section = sections?.[chosen] ?? null;
  const assetCount = useMemo(() => section?.beats.filter((b) => b.assetName).length ?? 0, [section]);

  const doImport = () => {
    if (!section) return;
    const result = importStoryboard(section);
    if (result.scenes === 0) return; // the store already explained why
    setImported(result);
    // Nothing left to do when the storyboard names no artwork (an unfilled generation brief) —
    // the prompts are in place, so close and let the normal image flow take over.
    if (assetCount === 0) {
      toast(`${result.scenes} scenes imported.`);
      onClose();
    }
  };

  const doAttach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      setAttached(await attachStoryboardImages(Array.from(files)));
    } finally {
      setAttaching(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Import storyboard</h2>

        {/* Step 1 — pick the file. */}
        {!sections && (
          <>
            <p className="muted small">
              Reads a markdown storyboard and rebuilds this project's scenes from it: one scene per
              table row, with its narration, image prompt, and artwork filename. Cut points come
              from matching each row's narration against the transcript, not from the file's
              estimated timecodes.
            </p>
            <div
              className={`dropzone compact ${dragOver ? 'over' : ''}`}
              onClick={() => mdInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void readFile(e.dataTransfer.files[0]);
              }}
            >
              <div className="dz-inner">
                <div className="dz-icon">
                  <FileText size={20} weight="regular" />
                </div>
                <strong>Drop your storyboard .md here</strong>
                <span className="muted">or click to browse</span>
              </div>
              <input
                ref={mdInput}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                hidden
                onChange={(e) => {
                  void readFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            {parseError && <div className="error-box">{parseError}</div>}
          </>
        )}

        {/* Step 2 — pick the section and review its beats. */}
        {sections && !imported && (
          <>
            <p className="muted small">
              <strong>{fileName}</strong> — {sections.length} scene{sections.length === 1 ? '' : 's'} found. This
              project is one audio clip, so pick the one that matches <strong>{project.audioName}</strong>.
            </p>
            <div className="sb-sections">
              {sections.map((s, i) => (
                <label key={i} className={`sb-section ${i === chosen ? 'on' : ''}`}>
                  <input type="radio" name="sb-section" checked={i === chosen} onChange={() => setChosen(i)} />
                  <span className="sb-section-label">
                    <strong>{s.title}</strong>
                    <span className="muted small">
                      {s.beats.length} beat{s.beats.length === 1 ? '' : 's'}
                      {s.beats.filter((b) => b.assetName).length > 0 &&
                        ` · ${s.beats.filter((b) => b.assetName).length} with artwork`}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {section && (
              <div className="sb-preview">
                <table className="sb-table">
                  <tbody>
                    {section.beats.map((b, i) => (
                      <tr key={i}>
                        <td className="sb-num muted">{b.index}</td>
                        <td className="sb-time muted small">
                          {Number.isFinite(b.tStart) ? fmtTime(b.tStart) : '—'}
                        </td>
                        <td className="sb-text">{b.narration}</td>
                        <td className="sb-asset muted small">{b.assetName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted small">
              This replaces all {project.scenes.length} current scene{project.scenes.length === 1 ? '' : 's'} and
              their images. Undo (⌘Z) puts them back.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSections(null)}>
                Back
              </button>
              <button className="btn primary" onClick={doImport} disabled={!section}>
                Import {section?.beats.length ?? 0} scenes
              </button>
            </div>
          </>
        )}

        {/* Step 3 — match a folder of artwork to the imported scenes. */}
        {imported && (
          <>
            <p className="small">
              <strong>
                {imported.scenes} scene{imported.scenes === 1 ? '' : 's'} imported.
              </strong>{' '}
              {imported.needsReview > 0 ? (
                <span className="warn-text">
                  <WarningCircle size={13} weight="fill" /> {imported.needsReview} couldn't be found in the
                  transcript — those are marked in the editor and need their timing checked.
                </span>
              ) : (
                <span className="muted">Every beat was matched to the transcript.</span>
              )}
            </p>

            {!attached && (
              <>
                <p className="muted small">
                  {assetCount} scene{assetCount === 1 ? '' : 's'} name artwork. Pick the folder holding those
                  files and they'll be attached by filename.
                </p>
                <div className="modal-actions spread">
                  <button className="btn ghost" onClick={() => filesInput.current?.click()} disabled={attaching}>
                    Choose files instead
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => folderInput.current?.click()}
                    disabled={attaching}
                  >
                    <FolderOpen size={14} weight="fill" /> {attaching ? 'Attaching…' : 'Choose asset folder'}
                  </button>
                </div>
                <input
                  ref={folderInput}
                  type="file"
                  hidden
                  multiple
                  /* Directory picking is non-standard, so a plain multi-file input is offered too. */
                  {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  onChange={(e) => {
                    void doAttach(e.target.files);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={filesInput}
                  type="file"
                  hidden
                  multiple
                  accept="image/*"
                  onChange={(e) => {
                    void doAttach(e.target.files);
                    e.target.value = '';
                  }}
                />
              </>
            )}

            {attached && (
              <>
                <p className="small">
                  <strong>
                    {attached.matched} of {attached.total} image{attached.total === 1 ? '' : 's'} attached.
                  </strong>
                </p>
                {attached.missing.length > 0 && (
                  <div className="sb-missing">
                    <span className="muted small">
                      No file matched these names — check they're in the folder you picked, or attach them
                      per scene:
                    </span>
                    <ul className="muted small">
                      {attached.missing.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            <div className="modal-actions">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
