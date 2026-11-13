// InfoStackFilesComponent — pure view-model module (`*.vm.ts`, #190).
//
// A RAW+JPEG stack is one tile over two files (#5050); the Info pane lists
// both, the RAW first and marked primary. No `@angular/*` imports.

import type { Asset } from '../models/asset';

export interface StackFileRowVm {
  readonly key: string;
  readonly name: string;
  readonly type: 'RAW' | 'JPEG';
  readonly size: string;
  readonly primary: boolean;
}

/** Compact byte count: 13478912 → "12.9 MB"; unknown sizes read "—". */
export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** The RAW (primary) and its JPEG companion; empty for an unstacked asset. */
export function stackFileRows(asset: Asset | null): readonly StackFileRowVm[] {
  if (!asset?.stack) return [];
  const { companion } = asset.stack;
  return [
    {
      key: asset.id,
      name: asset.filename,
      type: 'RAW',
      size: formatFileSize(asset.size),
      primary: true,
    },
    {
      key: companion.id,
      name: companion.name,
      type: 'JPEG',
      size: formatFileSize(companion.size),
      primary: false,
    },
  ];
}
