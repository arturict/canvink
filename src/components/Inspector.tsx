import {
  FileText,
  Image as ImageIcon,
  ListChecks,
  Plus,
  SlidersHorizontal,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { createId } from '../domain/ids';
import type { PageElement } from '../domain/types';

interface InspectorProps {
  element: PageElement | null;
  onUpdate: (patch: Partial<PageElement>) => void;
  onDelete: () => void;
  onClose: () => void;
  onEditText: () => void;
}

export default function Inspector({
  element,
  onUpdate,
  onDelete,
  onClose,
  onEditText,
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
        {element.kind === 'checklist' ? <ListChecks size={16} /> : null}
        {element.kind === 'stroke' ? <SlidersHorizontal size={16} /> : null}
        {element.kind === 'image' ? <ImageIcon size={16} /> : null}
        {element.kind === 'pdf' ? <FileText size={16} /> : null}
        <strong>{element.kind}</strong>
      </div>

      {element.kind === 'text' ? (
        <>
          <div className="inline-edit-callout">
            <p>Edit the words where they appear on the page.</p>
            <button type="button" onClick={onEditText}>
              <Type size={15} />
              Edit text on page
            </button>
          </div>
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
          <div className="field-row">
            <label className="field">
              <span>Style</span>
              <select
                value={element.fontStyle ?? 'normal'}
                onChange={(event) =>
                  onUpdate({
                    fontStyle: event.target.value as 'normal' | 'italic',
                  })
                }
              >
                <option value="normal">Normal</option>
                <option value="italic">Italic</option>
              </select>
            </label>
            <label className="field">
              <span>Decoration</span>
              <select
                value={element.textDecoration ?? 'none'}
                onChange={(event) =>
                  onUpdate({
                    textDecoration: event.target.value as
                      | 'none'
                      | 'underline'
                      | 'line-through',
                  })
                }
              >
                <option value="none">None</option>
                <option value="underline">Underline</option>
                <option value="line-through">Strike</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Align</span>
              <select
                value={element.textAlign ?? 'left'}
                onChange={(event) =>
                  onUpdate({
                    textAlign: event.target.value as 'left' | 'center' | 'right',
                  })
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="field">
              <span>List</span>
              <select
                value={element.listStyle ?? 'none'}
                onChange={(event) =>
                  onUpdate({
                    listStyle: event.target.value as 'none' | 'bullet' | 'numbered',
                  })
                }
              >
                <option value="none">None</option>
                <option value="bullet">Bullets</option>
                <option value="numbered">Numbered</option>
              </select>
            </label>
          </div>
        </>
      ) : null}

      {element.kind === 'checklist' ? (
        <div className="checklist-properties">
          <div className="field-row">
            <label className="field">
              <span>Text size</span>
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
              <span>Color</span>
              <input
                type="color"
                value={element.color}
                onChange={(event) => onUpdate({ color: event.target.value })}
              />
            </label>
          </div>
          <div className="checklist-properties__items" aria-label="Checklist items">
            {element.items.map((item, index) => (
              <div className="checklist-properties__item" key={item.id}>
                <input
                  type="checkbox"
                  checked={item.checked}
                  aria-label={`Mark item ${index + 1} complete`}
                  onChange={() =>
                    onUpdate({
                      items: element.items.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, checked: !candidate.checked }
                          : candidate,
                      ),
                    })
                  }
                />
                <input
                  type="text"
                  value={item.text}
                  maxLength={64 * 1024}
                  aria-label={`Checklist item ${index + 1}`}
                  onChange={(event) =>
                    onUpdate({
                      items: element.items.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, text: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove checklist item ${index + 1}`}
                  disabled={element.items.length === 1}
                  onClick={() =>
                    onUpdate({
                      items: element.items.filter(
                        (candidate) => candidate.id !== item.id,
                      ),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="checklist-properties__add"
            disabled={element.items.length >= 200}
            onClick={() =>
              onUpdate({
                items: [
                  ...element.items,
                  { id: createId('check'), text: '', checked: false },
                ],
                height: Math.max(element.height, (element.items.length + 1) * 34 + 22),
              })
            }
          >
            <Plus size={14} />
            Add item
          </button>
        </div>
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
