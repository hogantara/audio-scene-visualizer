import { useEffect } from 'react';
import { isMac, mod } from '../lib/keyboard';

const redoKeys = isMac ? ['⌘⇧Z'] : ['Ctrl+Shift+Z', 'Ctrl+Y'];

const ROWS: [string, string[]][] = [
  ['Play / pause', ['Space']],
  ['Previous scene', ['←']],
  ['Next scene', ['→']],
  ['Undo', [mod('Z')]],
  ['Redo', redoKeys],
  ['Save now', [mod('S')]],
  ['Close dialogs', ['Esc']],
];

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table className="shortcuts-table">
          <tbody>
            {ROWS.map(([label, keys]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  {keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="muted small"> or </span>}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Undo/redo and save work anywhere; play/pause and scene jumps only apply while you're not
          typing in a text field.
        </p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
