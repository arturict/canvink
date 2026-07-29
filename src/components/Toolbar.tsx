import {
  Download,
  Eraser,
  FileDown,
  FileInput,
  FileText,
  Highlighter,
  ImagePlus,
  MousePointer2,
  PenLine,
  Type,
} from 'lucide-react';
import type { BrushSettings, EditorTool, PageMode } from '../domain/types';

interface ToolbarProps {
  tool: EditorTool;
  brush: BrushSettings;
  pageMode: PageMode;
  onToolChange: (tool: EditorTool) => void;
  onBrushChange: (brush: BrushSettings) => void;
  onPageModeChange: (mode: PageMode) => void;
  onImportImage: () => void;
  onImportPdf: () => void;
  onPortableImport: () => void;
  onExportJson: () => void;
  onExportMarkdown: () => void;
  onExportPng: () => void;
  onExportPdf: () => void;
}

const tools: Array<{
  id: EditorTool;
  label: string;
  shortcut: string;
  icon: typeof MousePointer2;
}> = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
  { id: 'pen', label: 'Pen', shortcut: 'P', icon: PenLine },
  { id: 'highlighter', label: 'Highlight', shortcut: 'H', icon: Highlighter },
  { id: 'eraser', label: 'Erase', shortcut: 'E', icon: Eraser },
  { id: 'text', label: 'Text', shortcut: 'T', icon: Type },
];

export default function Toolbar({
  tool,
  brush,
  pageMode,
  onToolChange,
  onBrushChange,
  onPageModeChange,
  onImportImage,
  onImportPdf,
  onPortableImport,
  onExportJson,
  onExportMarkdown,
  onExportPng,
  onExportPdf,
}: ToolbarProps) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Canvas tools">
      <div className="tool-group">
        {tools.map(({ id, label, shortcut, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`tool-button ${tool === id ? 'is-active' : ''}`}
            aria-pressed={tool === id}
            title={`${label} (${shortcut})`}
            onClick={() => onToolChange(id)}
          >
            <Icon size={18} strokeWidth={2} />
            <span>{label}</span>
            <kbd>{shortcut}</kbd>
          </button>
        ))}
      </div>

      <span className="toolbar-rule" aria-hidden="true" />

      <div className="brush-controls" aria-label="Brush settings">
        <label className="color-control" title="Ink color">
          <span className="sr-only">Ink color</span>
          <input
            type="color"
            value={brush.color}
            onChange={(event) => onBrushChange({ ...brush, color: event.target.value })}
          />
        </label>
        <label className="size-control">
          <span>Size</span>
          <input
            type="range"
            min="2"
            max="24"
            step="1"
            value={brush.size}
            onChange={(event) =>
              onBrushChange({ ...brush, size: Number(event.target.value) })
            }
          />
          <output>{brush.size}</output>
        </label>
      </div>

      <span className="toolbar-spacer" />

      <div className="mode-switch" aria-label="Page mode">
        <button
          type="button"
          className={pageMode === 'free' ? 'is-active' : ''}
          aria-pressed={pageMode === 'free'}
          onClick={() => onPageModeChange('free')}
        >
          Free
        </button>
        <button
          type="button"
          className={pageMode === 'a4' ? 'is-active' : ''}
          aria-pressed={pageMode === 'a4'}
          onClick={() => onPageModeChange('a4')}
        >
          A4
        </button>
      </div>

      <div className="asset-actions">
        <button type="button" className="icon-action" title="Add image" onClick={onImportImage}>
          <ImagePlus size={18} />
          <span className="sr-only">Add image</span>
        </button>
        <button type="button" className="icon-action" title="Add PDF preview" onClick={onImportPdf}>
          <FileText size={18} />
          <span className="sr-only">Add PDF preview</span>
        </button>
      </div>

      <details className="action-menu">
        <summary>
          <FileInput size={17} />
          Import
        </summary>
        <div className="action-menu__popover">
          <button type="button" onClick={onPortableImport}>
            <FileInput size={16} />
            JSON or Markdown
          </button>
          <button type="button" onClick={onImportImage}>
            <ImagePlus size={16} />
            Image
          </button>
          <button type="button" onClick={onImportPdf}>
            <FileText size={16} />
            PDF preview
          </button>
        </div>
      </details>

      <details className="action-menu action-menu--right">
        <summary>
          <Download size={17} />
          Export
        </summary>
        <div className="action-menu__popover">
          <button type="button" onClick={onExportJson}>
            <FileDown size={16} />
            Workspace JSON
          </button>
          <button type="button" onClick={onExportMarkdown}>
            <FileText size={16} />
            Page Markdown
          </button>
          <button type="button" onClick={onExportPng}>
            <ImagePlus size={16} />
            Page PNG
          </button>
          <button type="button" onClick={onExportPdf}>
            <FileText size={16} />
            Vector PDF
          </button>
        </div>
      </details>
    </div>
  );
}
