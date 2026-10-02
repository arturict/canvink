import { useEffect, useRef, type KeyboardEvent } from 'react';

interface InlineRenameProps {
  value: string;
  /** Accessible name of the text field. */
  label: string;
  className?: string;
  /**
   * Called once. `title` is the trimmed new name, or null when the rename was
   * cancelled (Escape) or the name is empty or unchanged.
   */
  onDone: (title: string | null) => void;
}

/**
 * A label turned into a text field in place, as OneNote does when a notebook,
 * section or page is renamed. Enter or leaving the field saves, Escape
 * cancels, and an empty name keeps the old one.
 */
export function InlineRename({ value, label, className, onDone }: InlineRenameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const title = inputRef.current?.value.trim() ?? '';
    onDone(commit && title && title !== value ? title : null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Arrow keys, Space, Home and End belong to the text field, not to the
    // list or popover around it.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className={className ? `inline-rename ${className}` : 'inline-rename'}
      aria-label={label}
      defaultValue={value}
      enterKeyHint="done"
      autoComplete="off"
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
