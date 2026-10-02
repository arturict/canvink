import { MathEngineError } from './types';

export interface UnitConversionRequest {
  readonly expression: string;
  readonly targetUnit: string;
}

export interface UnitConversionValue {
  readonly formatted: string;
  readonly canonicalUnit: string;
  readonly exchangeRate?: {
    readonly source: string;
    readonly date: string;
  };
}

export interface UnitConversionPort {
  readonly availability: 'available' | 'unavailable';
  convert(request: UnitConversionRequest): Promise<UnitConversionValue>;
}

/**
 * The browser build deliberately has no imitation unit engine. A native Tauri
 * adapter or a pinned, audited Numbat WASM build can implement this port later.
 */
export class UnavailableWebUnitConversionPort implements UnitConversionPort {
  readonly availability = 'unavailable' as const;

  async convert(request: UnitConversionRequest): Promise<UnitConversionValue> {
    void request;
    throw new MathEngineError(
      'unit-engine-unavailable',
      'Dimension-safe Numbat conversion is unavailable in this web runtime.',
    );
  }
}
