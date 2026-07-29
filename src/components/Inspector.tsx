import { FileText, Image as ImageIcon, SlidersHorizontal, Trash2, Type } from 'lucide-react';
import type { Ref } from 'react';
import { MAX_TEXT_CHARS } from '../domain/limits';
import type { PageElement } from '../domain/types';

interface InspectorProps {
  element: PageElement | null;
  textInputRef?: Ref<HTMLTextAreaElement>;
  onUpdate: (patch: Partial<PageElement>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function Inspector({
  element,
  textInputRef,
  onUpdate,
  onDelete,
  onClose,
}: InspectorProps) {
  if (!element) return null;

  return (
    <aside className="inspector" aria-label="Object properties">
      <div className="inspector-heading">
        <span>
          <SlidersHorizontal size={15} />
          Properties
        </span>
        <button type="button" onClick={onClose} aria-label="Close properties">
          ×
        </button>
      </div>

      <div className="object-kind">
        {element.kind === 'text' ? <Type size={16} /> : null}
        {element.kind === 'stroke' ? <SlidersHorizontal size={16} /> : null}
        {element.kind === 'image' ? <ImageIcon size={16} /> : null}
        {element.kind === 'pdf' ? <FileText size={16} /> : null}
        <strong>{element.kind}</strong>
      </div>

      {element.kind === 'text' ? (
        <>
          <label className="field">
            <span>Text</span>
            <textarea
              ref={textInputRef}
              value={element.text}
              maxLength={MAX_TEXT_CHARS}
              rows={8}
              placeholder="Write your note"
              onChange={(event) => onUpdate({ text: event.target.value })}
              autoFocus
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Size</span>
              <input
                type="number"
                min="8"
                max="120"
                value={element.fontSize}
                onChange={(event) => {
                  const fontSize = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(fontSize)) {
                    onUpdate({ fontSize: Math.min(120, Math.max(8, fontSize)) });
                  }
                }}
              />
            </label>
            <label className="field">
              <span>Weight</span>
              <select
                value={element.fontWeight}
                onChange={(event) =>
                  onUpdate({
                    fontWeight: Number(event.target.value) as 400 | 500 | 600 | 700,
                  })
                }
              >
                <option value="400">Regular</option>
                <option value="500">Medium</option>
                <option value="600">Semibold</option>
                <option value="700">Bold</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Color</span>
            <input
              type="color"
              value={element.color}
              onChange={(event) => onUpdate({ color: event.target.value })}
            />
          </label>
        </>
      ) : null}

      {element.kind === 'stroke' ? (
        <>
          <label className="field">
            <span>Ink color</span>
            <input
              type="color"
              value={element.color}
              onChange={(event) => onUpdate({ color: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Stroke size</span>
            <input
              type="range"
              min="2"
              max="40"
              value={element.size}
              onChange={(event) => onUpdate({ size: Number(event.target.value) })}
            />
          </label>
          <p className="inspector-note">
            {element.points.length} raw pointer samples with pressure and tilt are stored.
          </p>
        </>
      ) : null}

      {element.kind === 'image' ? (
        <>
          <label className="field">
            <span>Alt text</span>
            <input
              type="text"
              value={element.alt}
              maxLength={64 * 1024}
              onChange={(event) => onUpdate({ alt: event.target.value })}
            />
          </label>
          <p className="inspector-note">{element.name}</p>
        </>
      ) : null}

      {element.kind === 'pdf' ? (
        <div className="pdf-properties">
          <strong>{element.sourceName}</strong>
          <span>{element.pageCount} pages</span>
          <p>
            The alpha keeps a movable first-page preview. It does not embed the source PDF in the
            portable workspace yet.
          </p>
        </div>
      ) : null}

      <button type="button" className="delete-object" onClick={onDelete}>
        <Trash2 size={15} />
        Move object to trash
      </button>
    </aside>
  );
}
