import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export type CalculatorPaletteCategory = 'basic' | 'scientific' | 'conversion';

export interface CalculatorCommand {
  id: string;
  label: string;
  insertText: string;
  category: CalculatorPaletteCategory;
}

export interface CalculatorPaletteLabels {
  palette: string;
  basic: string;
  scientific: string;
  conversion: string;
  result?: string;
  insertResult?: string;
}

export interface CalculatorResultInsertion {
  insertText: string;
  label?: string;
}

export interface CalculatorPaletteProps {
  labels: CalculatorPaletteLabels;
  commands?: readonly CalculatorCommand[];
  result?: CalculatorResultInsertion;
  viewer?: boolean;
  onInsert: (insertText: string, command: CalculatorCommand) => void;
  onInsertResult?: (insertText: string) => void;
}

export const DEFAULT_CALCULATOR_COMMANDS: readonly CalculatorCommand[] = [
  { id: 'plus', label: '+', insertText: '+', category: 'basic' },
  { id: 'minus', label: '−', insertText: '-', category: 'basic' },
  { id: 'multiply', label: '×', insertText: '\\cdot', category: 'basic' },
  { id: 'divide', label: '÷', insertText: '\\frac{}{}', category: 'basic' },
  { id: 'fraction', label: 'a/b', insertText: '\\frac{}{}', category: 'basic' },
  { id: 'power', label: 'xⁿ', insertText: '^{}', category: 'scientific' },
  { id: 'root', label: '√', insertText: '\\sqrt{}', category: 'scientific' },
  { id: 'sin', label: 'sin', insertText: '\\sin()', category: 'scientific' },
  { id: 'cos', label: 'cos', insertText: '\\cos()', category: 'scientific' },
  { id: 'log', label: 'log', insertText: '\\log()', category: 'scientific' },
  { id: 'length', label: 'm → cm', insertText: '1\\,\\mathrm{m} \\to \\mathrm{cm}', category: 'conversion' },
  { id: 'mass', label: 'kg → g', insertText: '1\\,\\mathrm{kg} \\to \\mathrm{g}', category: 'conversion' },
  { id: 'temperature', label: '°C → °F', insertText: '0\\,{}^\\circ\\mathrm{C} \\to {}^\\circ\\mathrm{F}', category: 'conversion' },
];

export function CalculatorPalette({
  labels,
  commands = DEFAULT_CALCULATOR_COMMANDS,
  result,
  viewer = false,
  onInsert,
  onInsertResult,
}: CalculatorPaletteProps) {
  const categories: readonly CalculatorPaletteCategory[] = ['basic', 'scientific', 'conversion'];
  return (
    <aside
      className="calculator-palette"
      aria-label={labels.palette}
      onPointerDown={isolateCanvasEvent}
      onPointerMove={isolateCanvasEvent}
      onPointerUp={isolateCanvasEvent}
      onPointerCancel={isolateCanvasEvent}
      onKeyDown={isolateCanvasEvent}
      onWheel={isolateCanvasEvent}
    >
      {result && onInsertResult ? (
        <section aria-labelledby="calculator-palette-result">
          <h3 id="calculator-palette-result">{labels.result ?? 'Result'}</h3>
          <div className="calculator-palette__grid">
            <button
              type="button"
              disabled={viewer}
              aria-label={labels.insertResult ?? 'Insert result'}
              onClick={() => onInsertResult(result.insertText)}
            >
              {result.label ?? result.insertText}
            </button>
          </div>
        </section>
      ) : null}
      {categories.map((category) => (
        <section key={category} aria-labelledby={`calculator-palette-${category}`}>
          <h3 id={`calculator-palette-${category}`}>{labels[category]}</h3>
          <div className="calculator-palette__grid">
            {commands.filter((command) => command.category === category).map((command) => (
              <button
                key={command.id}
                type="button"
                disabled={viewer}
                onClick={() => onInsert(command.insertText, command)}
              >
                {command.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </aside>
  );
}

export default CalculatorPalette;
