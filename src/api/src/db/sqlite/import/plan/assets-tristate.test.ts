/**
 * The screenshot flag keeps its three states through the importer (#3761).
 *
 * The column is the only tri-state in `assets`, and `ddl/assets.ts` explains
 * why at length: the describe stage is what distinguishes "not a screenshot"
 * from "not looked at yet", so a row that reads `false` for an asset the stage
 * has never reached is a wire-contract change dressed as a default.
 *
 * This has now collapsed three times from one schema decision — once on the
 * query side, once in the read transform, and once here in the importer — and
 * each time because nothing asserted the absent case. That is what this file
 * is for. It is pure: the mapper is called directly, so no database and no
 * fixture stand between the document and the row it becomes.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { assetsPlan } from './assets.ts';
import type { MapContext } from '../types.ts';

const CTX: MapContext = {
  stageNames: [],
  note: () => {},
  releasedLocation: () => false,
} as unknown as MapContext;

/** The `assets` row the plan produces for one source document. */
function assetRowFor(doc: Record<string, unknown>): { columns: string[]; row: unknown[] } {
  const tables = assetsPlan.map({ _id: new ObjectId(), ...doc }, CTX);
  const assets = tables.find((t) => t.table === 'assets');
  if (assets === undefined) throw new Error('the plan produced no assets row');
  return { columns: [...assets.columns], row: [...assets.rows[0]!] };
}

/** The value the plan writes into `is_screenshot`. */
function screenshotBit(doc: Record<string, unknown>): unknown {
  const { columns, row } = assetRowFor(doc);
  const at = columns.indexOf('is_screenshot');
  if (at === -1) throw new Error('is_screenshot is not a column of the assets row');
  return row[at];
}

describe('is_screenshot survives the import as three states', () => {
  it('writes NULL when the source document has no such field', () => {
    expect(screenshotBit({})).toBeNull();
  });

  it('writes NULL when the source field is explicitly null', () => {
    expect(screenshotBit({ is_screenshot: null })).toBeNull();
  });

  it('writes 0 only when the classifier said not a screenshot', () => {
    expect(screenshotBit({ is_screenshot: false })).toBe(0);
  });

  it('writes 1 when the classifier said screenshot', () => {
    expect(screenshotBit({ is_screenshot: true })).toBe(1);
  });

  it('keeps the neighbouring two-state flags non-null, which is correct for them', () => {
    const { columns, row } = assetRowFor({});
    for (const name of ['hidden', 'hidden_ack', 'has_xmp']) {
      const at = columns.indexOf(name);
      expect(at).toBeGreaterThan(-1);
      expect(row[at]).toBe(0);
    }
  });
});
