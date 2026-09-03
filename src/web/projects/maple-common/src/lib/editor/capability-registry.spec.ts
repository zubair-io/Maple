// The Web consumer of the generated capability registry (#2430). The
// registry is reviewed Rust (raw-core/src/capability_registry/) emitted by
// tools/codegen.sh; this spec pins what the web shell relies on: the
// registry's build matches the pipeline version the web caches key on,
// every field a capability owns is a real AdjustmentModel key, and a
// release state is never asserted — no Web-covering qualification source
// exists yet, so nothing shipped on Web may read `released`.
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY,
  CAPABILITY_REGISTRY_BUILD,
  type CapabilityEvidenceSource,
} from '../generated/capability-registry.generated';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-model.generated';
import { defaultAdjustmentModel } from '../models/adjustment-model';

/** Schema fields raw-core carries that the web `AdjustmentModel` does not
 * mirror: the as-shot interpretation flags (Apple-side sidecar state) and
 * the two model-only layer lists (see the registry's own comments). */
const RAW_CORE_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'temperature_seen',
  'tint_seen',
  'local_adjustments',
  'inpaint_removals',
]);

/** Web model keys that are not canonical schema fields: the WB preset
 * selector is a UI convenience that resolves to temperature / tint (see
 * `adjustment-model.ts`'s own header comment). */
const WEB_ONLY_KEYS: ReadonlySet<string> = new Set(['whiteBalancePreset']);

const WEB_COVERING: readonly CapabilityEvidenceSource[] = [
  'sidecar_contract_api',
  'gpu_chain_parity_lavapipe',
];

function camelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

describe('capability registry (generated)', () => {
  it('is built for the same pipeline version the web caches key on', () => {
    expect(CAPABILITY_REGISTRY_BUILD.pipelineOutputVersion).toBe(PIPELINE_OUTPUT_VERSION);
    expect(CAPABILITY_REGISTRY_BUILD.schemaVersion).toBeGreaterThan(0);
  });

  it('has unique, stable ids and every web-shipped develop capability', () => {
    const ids = CAPABILITY_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const web = CAPABILITY_REGISTRY.filter((c) => c.surfaces.includes('web')).map((c) => c.id);
    for (const id of ['white_balance', 'tone', 'color', 'detail', 'effects', 'geometry']) {
      expect(web).toContain(id);
    }
  });

  it('only attributes real AdjustmentModel fields to capabilities', () => {
    const known = new Set(Object.keys(defaultAdjustmentModel()));
    for (const capability of CAPABILITY_REGISTRY) {
      for (const field of capability.fields) {
        if (RAW_CORE_ONLY_FIELDS.has(field)) continue;
        expect(known.has(camelCase(field)), `${capability.id}.${field}`).toBe(true);
      }
    }
  });

  it('gives every web AdjustmentModel field exactly one capability owner', () => {
    // The reverse of raw-core's own coverage test: a new slider cannot ship
    // on Web without a capability — and therefore an owner and an evidence
    // declaration — behind it.
    const owners = new Map<string, string[]>();
    for (const capability of CAPABILITY_REGISTRY) {
      for (const field of capability.fields) {
        owners.set(camelCase(field), [...(owners.get(camelCase(field)) ?? []), capability.id]);
      }
    }
    for (const key of Object.keys(defaultAdjustmentModel())) {
      if (WEB_ONLY_KEYS.has(key)) continue;
      expect(owners.get(key)?.length, `${key} owners: ${owners.get(key) ?? []}`).toBe(1);
    }
  });

  it('never reads released on web without web-covering qualification evidence', () => {
    for (const capability of CAPABILITY_REGISTRY) {
      if (capability.releaseState !== 'released' || !capability.surfaces.includes('web')) continue;
      expect(
        capability.qualification.some((s) => WEB_COVERING.includes(s)),
        capability.id,
      ).toBe(true);
    }
  });
});
