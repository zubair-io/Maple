import { isAbsolute } from 'node:path';
import {
  parseExportRecipe,
  exportRecipeProblem,
  exportCaptureTime,
} from '../generated/export-recipe.generated.ts';
import type { ExportRecipe } from '../generated/export-recipe.generated.ts';

export interface ExportTarget {
  id: string;
  path: string;
  xmp: string;
  index: number;
  capturedAt: string | null;
}
export interface ExportPayload {
  targets: ExportTarget[];
  recipe: ExportRecipe;
}

function textField(entry: Record<string, unknown>, name: string): string {
  const value = entry[name];
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid photo ${name}`);
  return value;
}
function photoSequence(entry: Record<string, unknown>): {
  index: number;
  capturedAt: string | null;
} {
  const index = entry['index'];
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Every photo needs its stable sequence index');
  const capturedAt = entry['capturedAt'];
  if (capturedAt !== null && typeof capturedAt !== 'string')
    throw new Error('capturedAt must be EXIF date text or null');
  return { index, capturedAt: exportCaptureTime(capturedAt) };
}
function target(value: unknown): ExportTarget {
  if (!value || typeof value !== 'object') throw new Error('Invalid export photo');
  const entry = value as Record<string, unknown>;
  const id = textField(entry, 'id');
  const path = textField(entry, 'path');
  const xmp = textField(entry, 'xmp');
  if (!id || id.length > 2048 || !isAbsolute(path) || path.length > 8192)
    throw new Error('Every photo needs an id and an absolute original path');
  const { index, capturedAt } = photoSequence(entry);
  return { id, path, xmp, index, capturedAt };
}
export function parseExportPayload(raw: Record<string, unknown>): ExportPayload {
  const recipe = parseExportRecipe(raw['recipe']);
  const problem = exportRecipeProblem(recipe);
  if (problem) throw new Error(problem);
  if (recipe.destination !== 'directory' || !recipe.directory || !isAbsolute(recipe.directory))
    throw new Error('Server export needs an absolute directory within a registered library');
  const values = raw['targets'];
  if (!Array.isArray(values) || values.length < 1 || values.length > 2000)
    throw new Error('Choose 1–2,000 photos');
  const targets = values.map(target);
  if (new Set(targets.map((photo) => photo.id)).size !== targets.length)
    throw new Error('Export photo identities must be unique');
  if (new TextEncoder().encode(JSON.stringify({ targets, recipe })).length > 12_000_000)
    throw new Error('This export contains too many edit snapshots; split it into smaller batches');
  return { targets, recipe };
}
