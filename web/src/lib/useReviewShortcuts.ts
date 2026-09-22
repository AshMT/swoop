import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcuts for the review flow.
 *
 * Reviewing every classification is the single most repetitive thing an
 * operator does with Swoop, and the agreement rate is only as good as how many
 * they get through. Reaching for the mouse on each row is the difference
 * between reviewing a day's tickets and giving up halfway.
 */
export interface ReviewShortcutHandlers {
  onNext: () => void;
  onPrevious: () => void;
  onCorrect: () => void;
  onIncorrect: () => void;
  onToggleExpand: () => void;
  onClear: () => void;
}

/** Shown in the UI so the shortcuts are discoverable rather than folklore. */
export const REVIEW_SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: 'j / ↓', description: 'Next ticket' },
  { keys: 'k / ↑', description: 'Previous ticket' },
  { keys: 'y', description: 'Mark correct' },
  { keys: 'n', description: 'Mark incorrect' },
  { keys: 'x', description: 'Clear the review' },
  { keys: 'Enter', description: 'Expand or collapse' },
  { keys: '?', description: 'Show this list' },
];

/** True when the event came from somewhere typing should win. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}

export function useReviewShortcuts(handlers: ReviewShortcutHandlers, enabled: boolean): void {
  // Held in a ref so the listener does not need re-binding on every render.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal a keystroke from a field, or from a browser shortcut.
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const actions: Record<string, () => void> = {
        j: ref.current.onNext,
        ArrowDown: ref.current.onNext,
        k: ref.current.onPrevious,
        ArrowUp: ref.current.onPrevious,
        y: ref.current.onCorrect,
        n: ref.current.onIncorrect,
        x: ref.current.onClear,
        Enter: ref.current.onToggleExpand,
      };

      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
