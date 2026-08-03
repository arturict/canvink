import { BookOpen, Check, Search, Type, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { UiPreferences } from '../ui/preferences';

interface GettingStartedPanelProps {
  textSize: UiPreferences['textSize'];
  onTextSizeChange: (textSize: UiPreferences['textSize']) => void;
  onQuickNote: () => void;
  onFocusSearch: () => void;
  onOpenExample: () => void;
  onDismiss: () => void;
}

export default function GettingStartedPanel({
  textSize,
  onTextSizeChange,
  onQuickNote,
  onFocusSearch,
  onOpenExample,
  onDismiss,
}: GettingStartedPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <aside
      id="getting-started-panel"
      className="getting-started"
      aria-labelledby="getting-started-title"
    >
      <header>
        <div>
          <span className="app-eyebrow">Optional guide</span>
          <h2 id="getting-started-title">Start with what matters</h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onDismiss}
          aria-label="Close guide"
        >
          <X size={18} />
        </button>
      </header>

      <p className="getting-started__intro">
        Capture a thought now. Organize it when that becomes useful.
      </p>

      <div className="getting-started__actions" aria-label="Suggested first steps">
        <button type="button" className="getting-started__primary" onClick={onQuickNote}>
          <Type size={18} />
          <span>
            <strong>Write a quick note</strong>
            <small>Open a text field on a blank page.</small>
          </span>
        </button>
        <button type="button" onClick={onFocusSearch}>
          <Search size={18} />
          <span>
            <strong>Find something</strong>
            <small>Search page titles and note text on this device.</small>
          </span>
        </button>
        <button type="button" onClick={onOpenExample}>
          <BookOpen size={18} />
          <span>
            <strong>Open an example</strong>
            <small>See a filled page without changing your quick note.</small>
          </span>
        </button>
      </div>

      <div className="getting-started__checklist">
        <span className="app-eyebrow">A simple path</span>
        <ul>
          <li>
            <Check size={14} aria-hidden="true" />
            Capture
          </li>
          <li>
            <Check size={14} aria-hidden="true" />
            Name the page
          </li>
          <li>
            <Check size={14} aria-hidden="true" />
            Find it again
          </li>
        </ul>
      </div>

      <label className="getting-started__text-size">
        <span>Interface text size</span>
        <select
          value={textSize}
          onChange={(event) =>
            onTextSizeChange(event.target.value as UiPreferences['textSize'])
          }
        >
          <option value="default">Default</option>
          <option value="large">Large</option>
        </select>
      </label>

      <footer>
        <button type="button" className="getting-started__skip" onClick={onDismiss}>
          Skip for now
        </button>
        <small>Reopen this guide from Guide and display.</small>
      </footer>
    </aside>
  );
}
