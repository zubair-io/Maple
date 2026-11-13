// Readout and spoken-value formatting for MuiSlider
// (docs/design/maple-ui/components/slider.md § Variants, § Accessibility).
// The range picks the variant: min >= 0 reads as a plain value (`50%`,
// `0.3 EV`), min < 0 keeps the signed editor format. Drag Bar and Living
// Slider keep `formatSignedValue`; this file is Slider's own.

import { formatSignedValue } from '../internal/pointer-drag';

function decimalsFor(step: number): number {
  return step < 0.1 ? 2 : step < 1 ? 1 : 0;
}

function attachUnit(text: string, unit: string): string {
  return unit === '%' ? `${text}%` : unit ? `${text} ${unit}` : text;
}

export function formatSliderReadout(
  value: number,
  min: number,
  step: number,
  unit: string,
): string {
  return min >= 0
    ? attachUnit(value.toFixed(decimalsFor(step)), unit)
    : formatSignedValue(value, step, unit);
}

export function spokenSliderValue(value: number, min: number, step: number, unit: string): string {
  const magnitude = Math.abs(value).toFixed(decimalsFor(step));
  const spokenUnit = unit === '%' ? 'percent' : unit;
  const body = spokenUnit ? `${magnitude} ${spokenUnit}` : magnitude;
  const isZero = Number(magnitude) === 0;
  return min >= 0 || isZero ? body : `${value > 0 ? 'plus' : 'minus'} ${body}`;
}
