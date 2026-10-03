import type { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import type { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import type { AssetId } from '../../projects/maple-common/src/lib/models/asset';
import { ADJUSTMENT_RANGES } from '../../projects/maple-common/src/lib/generated/adjustment-tables.generated';
import { stableStringify } from '../../projects/maple-common/src/lib/editor/edit-transaction';

/** Real RAW analysis, visible values and exactly one shipping editor transaction. */
export async function applyAutoTone(
  editor: EditorStateService,
  id: AssetId,
  pipeline: RawPipelineService,
  bytes: Uint8Array,
): Promise<boolean> {
  const before = editor.currentAdjustment()!;
  const count = editor.undoHistory().length;
  const recommendation = await pipeline.computeAutoAdjustments(bytes, 'dng');
  const changed = await editor.applyAuto(id);
  const applied = editor.currentAdjustment()!;
  if (editor.undoHistory().length !== count + 1 || editor.undoHistory().at(-1)?.kind !== 'auto')
    throw Error('Auto Tone must create exactly one Auto transaction');
  const fields = [
    'exposure',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'temperature',
    'tint',
  ] as const;
  for (const field of fields) {
    const [min, max] = ADJUSTMENT_RANGES[field];
    if (applied[field] !== Math.min(max, Math.max(min, recommendation[field])))
      throw Error(`Auto Tone did not apply the visible ${field} recommendation`);
  }
  if (
    applied.autoExposure !== 'Off' ||
    applied.whiteBalancePreset !== 'Auto' ||
    applied.wbSource !== 'Auto' ||
    applied.wbAlgorithmVersion <= 0
  )
    throw Error('Auto Tone provenance or exposure intent is missing');
  const expected = {
    ...before,
    ...Object.fromEntries(fields.map((field) => [field, applied[field]])),
    autoExposure: applied.autoExposure,
    whiteBalancePreset: applied.whiteBalancePreset,
    partialWhiteBalance: applied.partialWhiteBalance,
    wbScaleVersion: applied.wbScaleVersion,
    wbSource: applied.wbSource,
    wbSampleX: applied.wbSampleX,
    wbSampleY: applied.wbSampleY,
    wbAlgorithmVersion: applied.wbAlgorithmVersion,
  };
  if (stableStringify(applied) !== stableStringify(expected))
    throw Error('Auto Tone changed the rendering profile or unrelated controls');
  return changed;
}

export function withWorkflowMetadata(xml: string, tag: 'A' | 'B'): string {
  const caption = `<dc:description xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Alt><rdf:li xml:lang="x-default">Caption ${tag}</rdf:li></rdf:Alt></dc:description>`;
  const content = `${caption}${foreignAudit(tag)}`;
  const result = xml.includes('</rdf:Description>')
    ? xml.replace('</rdf:Description>', `${content}</rdf:Description>`)
    : xml.replace(/(<rdf:Description\b[^>]*?)\/>/, `$1>${content}</rdf:Description>`);
  if (result === xml) throw Error('Workflow fixture metadata was not inserted');
  return result;
}
export function foreignAudit(tag: 'A' | 'B'): string {
  return `<foreign:Audit xmlns:foreign="urn:maple:test" z="${tag}" a="retained"> ${tag} &amp; unchanged </foreign:Audit>`;
}
