export const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True if the given event target is a place where keys should type normally, not trigger shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export function isUndoShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
}

export function isRedoShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  return (e.metaKey || e.ctrlKey) && ((e.shiftKey && k === 'z') || k === 'y');
}

export function isSaveShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
}

/** Platform-appropriate label for a shortcut, e.g. mod('Z') -> "⌘Z" on Mac, "Ctrl+Z" elsewhere. */
export function mod(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
