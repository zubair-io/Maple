// The cross-client derivation corpus (#5079): the browser's HostedMapleIdService
// must mint the id the server and the Apple clients mint for the same bytes.
// `test-fixtures/ids/derivation.json` is pinned by src/api/tests/
// maple-id-contract.test.ts, raw-core's maple_id_derivation_corpus.rs and MapleCore's
// MapleIdDerivationContractTests.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { HostedMapleIdService } from './hosted-maple-id.service';
import { fallback } from './maple-id';
import { MapleIdCacheService } from './maple-id-cache';
import { MapleIdFallbackHasherService } from './maple-id-fallback-hasher.service';

const idsDir = '../../test-fixtures/ids';
const corpus = JSON.parse(readFileSync(resolve(idsDir, 'derivation.json'), 'utf8')) as {
  cases: { file: string; capturedAt: string | null; id: string; optional?: boolean }[];
};

describe('maple_id derivation corpus', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MapleIdFallbackHasherService,
          useValue: {
            hashFallback: async (file: File) =>
              fallback(new Uint8Array(await file.arrayBuffer()), file.size).hex,
          },
        },
        { provide: MapleIdCacheService, useValue: {} },
      ],
    });
  });

  // Optional cases are gitignored RAWs of up to 130 MB; the API, raw-core and
  // MapleCore suites read them in place.
  for (const { file, capturedAt, id } of corpus.cases.filter((c) => !c.optional)) {
    it(`derives ${id} for ${file}`, async () => {
      const bytes = new Uint8Array(readFileSync(resolve(idsDir, file)));
      const derived = await TestBed.inject(HostedMapleIdService).computeMapleId(
        new File([bytes], file),
      );
      expect(derived.hex).toBe(id);
      expect(derived.kind).toBe(capturedAt === null ? 'fallback' : 'primary');
    });
  }
});
