# Batch Metadata — M0a: TypeScript XMP Metadata Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-authored capture/IPTC metadata (GPS, capture date/time, time zone, place text, title/caption/headline/instructions, creator & rights) to Maple's TypeScript XMP sidecar layer — parsed and serialized non-destructively alongside the existing adjustment + culling blocks.

**Architecture:** Metadata is a _separate concern_ from `AdjustmentModel` (exactly like the existing `XmpCulling`). A new `XmpMetadata` type carries the values in native units (signed decimal degrees, ISO datetime strings, plain strings). A focused `xmp-metadata.ts` helper module owns the standard-XMP encodings (GPS deg/min rationals, altitude rationals, lang-alt/seq RDF containers, copyright-status mapping). `XmpSerializerService.serialize()` gains an optional `metadata` argument; `XmpParserService` gains `parseMetadata()`. New attribute keys join `KNOWN_ATTRIBUTES` and new nested elements join the passthrough-exclusion list so nothing double-emits. This is the M0a foundation referenced by the spec; Swift parity, Rust tolerance, codegen constants, and the API/effective-resolver land in later plans.

**Tech Stack:** TypeScript, Angular (services), Vitest (the maple-common test runner), the browser `DOMParser` (already used by the parser).

**Spec:** `docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md`

**Parity contract (per spec):** per-platform **byte-stable** round-trip (`serialize → parse → serialize` identical) and cross-platform **semantic** parity. NOT cross-platform byte-identical (pre-existing TS↔Swift divergence is separate KTLO debt).

---

## Running tests

`maple-common` uses the `@angular/build:unit-test` builder (vitest under the hood). The builder compiles the whole library, so the generated `raw_wasm` pkg must be present (see provisioning below). One-shot, scoped run (verified):

```bash
cd src/web && HOME=/tmp/maple-binst bun x ng test Maple-common --watch=false --filter=gps
```

**`--filter` matches TEST NAMES (describe/it text), not file paths** (verified: `--filter=gps` runs exactly the `gpsToXmp`/`gpsFromXmp` describes). Use a describe-name token from the task you're running (e.g. `gps`, `altitude`, `metadataAttrParts`, `parseMetadata`). Drop `--filter` to run the whole library suite. `--watch=false` makes it one-shot.

**Known-red baseline:** the maple-common suite has a pre-existing failing observability spec on `origin/main`. The gate for this work is **no NEW failures** — confirm every new `xmp-metadata*` test passes in the run output and the total failure count is unchanged from base. The pure-function spec (`xmp-metadata.spec.ts`) imports from `vitest` directly; the service round-trip spec instantiates the dependency-free services directly with `new` (TestBed.inject is the house alternative and also works).

**First run in a fresh worktree (provisioning):** (1) install deps with a HOME override — `HOME=/tmp/maple-binst bun install` (the default `bun install` is blocked by a socket scanner in worktrees); (2) build + sync the WASM pkg — `bash src/raw-pipeline/scripts/build-raw-wasm.sh && bash src/web/scripts/sync-raw-wasm.sh` (the test build compiles the raw-pipeline worker, which imports `raw_wasm`). Use the same `HOME=/tmp/maple-binst` prefix for `bun x ng test`.

---

## File Structure

| File                                                                       | Responsibility                                       | Change                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `src/web/projects/maple-common/src/lib/xmp/xmp.types.ts`                   | Shared XMP value types                               | **Modify** — add `CopyrightStatus`, `XmpMetadata`                |
| `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`                | Standard-XMP encodings + field tables for metadata   | **Create**                                                       |
| `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`           | Unit tests for the encodings                         | **Create**                                                       |
| `src/web/projects/maple-common/src/lib/xmp/xmp-serializer.service.ts`      | Serialize model+culling+**metadata** → XMP           | **Modify** — accept `metadata`, emit attrs + nested + namespaces |
| `src/web/projects/maple-common/src/lib/xmp/xmp-parser.service.ts`          | Parse XMP → model/culling/**metadata** + passthrough | **Modify** — add `parseMetadata`, extend known set + exclusion   |
| `src/web/projects/maple-common/src/lib/xmp/xmp-metadata-roundtrip.spec.ts` | End-to-end round-trip + byte-stable + no-double-emit | **Create**                                                       |

**Field set (native units in `XmpMetadata`; XMP encoding in parens):**

- `gpsLatitude`, `gpsLongitude`: signed decimal degrees (`exif:GPSLatitude/Longitude`, `DDD,MM.mmmm{N|S|E|W}`)
- `gpsAltitude`: signed meters (`exif:GPSAltitude` rational + `exif:GPSAltitudeRef` 0/1)
- `dateTimeOriginal`: ISO-8601 with offset, e.g. `2026-06-26T18:40:00+02:00` (`exif:DateTimeOriginal`)
- `timeZone`: IANA name, e.g. `Europe/Paris` (`papp:TimeZone`)
- `sublocation` (`Iptc4xmpCore:Location`), `city` (`photoshop:City`), `state` (`photoshop:State`), `country` (`photoshop:Country`), `countryCode` (`Iptc4xmpCore:CountryCode`)
- `title` (`dc:title`, lang-alt), `caption` (`dc:description`, lang-alt), `headline` (`photoshop:Headline`), `instructions` (`photoshop:Instructions`)
- `creator` (`dc:creator`, seq), `creatorJobTitle` (`photoshop:AuthorsPosition`), `copyrightNotice` (`dc:rights`, lang-alt), `copyrightStatus` (`xmpRights:Marked`), `usageTerms` (`xmpRights:UsageTerms`, lang-alt), `credit` (`photoshop:Credit`), `source` (`photoshop:Source`)

> Keywords (`dc:subject`) already live in `XmpCulling.keywords` — out of scope here.

**Deterministic emission order (for per-platform byte-stability):**

- _Attributes_ appended after culling, before passthrough, in this order: `exif:GPSLatitude`, `exif:GPSLongitude`, `exif:GPSAltitude`, `exif:GPSAltitudeRef`, `exif:DateTimeOriginal`, `papp:TimeZone`, `Iptc4xmpCore:Location`, `photoshop:City`, `photoshop:State`, `photoshop:Country`, `Iptc4xmpCore:CountryCode`, `photoshop:Headline`, `photoshop:Instructions`, `photoshop:AuthorsPosition`, `photoshop:Credit`, `photoshop:Source`, `xmpRights:Marked`.
- _Nested elements_ among the children, in this order: `dc:title`, `dc:creator`, `dc:description`, `dc:subject` (existing keywords), `dc:rights`, `xmpRights:UsageTerms`, then passthrough `unknownNodes`.
- _Namespace declarations_: always `xmp`, `crs`, `papp`; then conditionally (only when used) `dc`, `exif`, `photoshop`, `Iptc4xmpCore`, `xmpRights`, in that order.

---

## Task 1: GPS coordinate ↔ decimal conversion

**Files:**

- Create: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `xmp-metadata.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { gpsToXmp, gpsFromXmp } from './xmp-metadata';

describe('gpsToXmp', () => {
  it('encodes a northern latitude as deg,decimal-min with N', () => {
    expect(gpsToXmp(48.8566, 'lat')).toBe('48,51.3960N');
  });
  it('encodes a southern latitude with S and positive minutes', () => {
    expect(gpsToXmp(-33.8688, 'lat')).toBe('33,52.1280S');
  });
  it('encodes a western longitude with W', () => {
    expect(gpsToXmp(-73.9857, 'lon')).toBe('73,59.1420W');
  });
  it('encodes an eastern longitude with E', () => {
    expect(gpsToXmp(2.3522, 'lon')).toBe('2,21.1320E');
  });
});

describe('gpsFromXmp', () => {
  it('decodes N latitude back to signed decimal', () => {
    expect(gpsFromXmp('48,51.3960N')).toBeCloseTo(48.8566, 4);
  });
  it('decodes S latitude as negative', () => {
    expect(gpsFromXmp('33,52.1280S')).toBeCloseTo(-33.8688, 4);
  });
  it('decodes W longitude as negative', () => {
    expect(gpsFromXmp('73,59.1420W')).toBeCloseTo(-73.9857, 4);
  });
  it('returns null for malformed input', () => {
    expect(gpsFromXmp('not-a-coord')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: FAIL — `gpsToXmp`/`gpsFromXmp` not exported (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `xmp-metadata.ts` with:

```typescript
// xmp-metadata.ts — standard-XMP encodings + field tables for the IPTC/EXIF
// metadata block (Batch Metadata, spec 2026-06-26). Kept separate from the
// adjustment/culling field tables so the serializer/parser stay focused.

/** Axis selector for GPS encoding (picks the N/S vs E/W hemisphere suffix). */
export type GpsAxis = 'lat' | 'lon';

/**
 * Encode a signed decimal degree to the Adobe XMP `exif:GPSLatitude/Longitude`
 * form: `DDD,MM.mmmm{N|S|E|W}` (degrees, decimal-minutes, hemisphere). Minutes
 * are formatted to 4 decimal places — Lightroom's precision (~2cm).
 */
export function gpsToXmp(value: number, axis: GpsAxis): string {
  const positive = value >= 0;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const hemi = axis === 'lat' ? (positive ? 'N' : 'S') : positive ? 'E' : 'W';
  return `${deg},${min.toFixed(4)}${hemi}`;
}

/**
 * Decode an `exif:GPSLatitude/Longitude` string back to signed decimal
 * degrees. Accepts the canonical `DDD,MM.mmmm{N|S|E|W}` form. Returns `null`
 * if the string does not match (so a hand-edited sidecar never throws).
 */
export function gpsFromXmp(s: string): number | null {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sign = m[3] === 'S' || m[3] === 'W' ? -1 : 1;
  return sign * (deg + min / 60);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts
git commit -m "feat(xmp): GPS decimal<->XMP deg/min conversion for metadata block"
```

---

## Task 2: Altitude ↔ rational conversion

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `xmp-metadata.spec.ts`:

```typescript
import { altitudeToXmp, altitudeFromXmp } from './xmp-metadata';

describe('altitudeToXmp', () => {
  it('encodes a positive altitude as a /1000 rational, ref 0', () => {
    expect(altitudeToXmp(35)).toEqual({ value: '35000/1000', ref: '0' });
  });
  it('encodes a below-sea-level altitude with ref 1 and positive magnitude', () => {
    expect(altitudeToXmp(-12.5)).toEqual({ value: '12500/1000', ref: '1' });
  });
});

describe('altitudeFromXmp', () => {
  it('decodes a /1000 rational with ref 0 to positive meters', () => {
    expect(altitudeFromXmp('35000/1000', '0')).toBeCloseTo(35, 3);
  });
  it('decodes ref 1 to negative meters', () => {
    expect(altitudeFromXmp('12500/1000', '1')).toBeCloseTo(-12.5, 3);
  });
  it('returns null for a malformed rational', () => {
    expect(altitudeFromXmp('abc', '0')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: FAIL — `altitudeToXmp`/`altitudeFromXmp` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `xmp-metadata.ts`:

```typescript
/** `exif:GPSAltitude` rational + `exif:GPSAltitudeRef` (0 = above, 1 = below). */
export interface XmpAltitude {
  value: string;
  ref: '0' | '1';
}

/** Encode signed meters as a `/1000` rational + altitude-ref flag. */
export function altitudeToXmp(meters: number): XmpAltitude {
  const ref: '0' | '1' = meters < 0 ? '1' : '0';
  const thousandths = Math.round(Math.abs(meters) * 1000);
  return { value: `${thousandths}/1000`, ref };
}

/** Decode an altitude rational + ref back to signed meters; `null` if malformed. */
export function altitudeFromXmp(value: string, ref: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const denom = Number(m[2]);
  if (denom === 0) return null;
  const meters = Number(m[1]) / denom;
  return ref === '1' ? -meters : meters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts
git commit -m "feat(xmp): altitude<->rational conversion for GPS metadata"
```

---

## Task 3: lang-alt + seq RDF container build/parse helpers

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`

These emit/read the nested `rdf:Alt` (lang-alt) and `rdf:Seq` containers. Indentation matches the existing `dc:subject` block in `xmp-serializer.service.ts` (2-space step: element at 2, container at 3, `rdf:li` at 4 spaces). Parsing reuses `DOMParser` semantics consistent with the existing keyword parse.

- [ ] **Step 1: Write the failing test**

Append to `xmp-metadata.spec.ts`:

```typescript
import { langAltBlock, seqBlock, escapeXmlText } from './xmp-metadata';

describe('langAltBlock', () => {
  it('emits an x-default rdf:Alt block with 2-space indentation', () => {
    expect(langAltBlock('dc:title', 'Sunset')).toBe(
      [
        '  <dc:title>',
        '   <rdf:Alt>',
        '    <rdf:li xml:lang="x-default">Sunset</rdf:li>',
        '   </rdf:Alt>',
        '  </dc:title>',
      ].join('\n'),
    );
  });
  it('escapes XML text content', () => {
    expect(langAltBlock('dc:rights', '© A & B <x>')).toContain(
      '<rdf:li xml:lang="x-default">© A &amp; B &lt;x&gt;</rdf:li>',
    );
  });
});

describe('seqBlock', () => {
  it('emits an rdf:Seq with one rdf:li', () => {
    expect(seqBlock('dc:creator', 'Ansel Adams')).toBe(
      [
        '  <dc:creator>',
        '   <rdf:Seq>',
        '    <rdf:li>Ansel Adams</rdf:li>',
        '   </rdf:Seq>',
        '  </dc:creator>',
      ].join('\n'),
    );
  });
});

describe('escapeXmlText', () => {
  it('escapes &, <, >', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `xmp-metadata.ts`:

```typescript
/** Minimal XML text-content escaping (matches the serializer's `_escapeText`). */
export function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Build a lang-alt nested element:
 *   <prefix:Name><rdf:Alt><rdf:li xml:lang="x-default">text</rdf:li></rdf:Alt></prefix:Name>
 * Indentation mirrors the existing `dc:subject` block (2/3/4 spaces).
 */
export function langAltBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Alt>',
    `    <rdf:li xml:lang="x-default">${escapeXmlText(text)}</rdf:li>`,
    '   </rdf:Alt>',
    `  </${qname}>`,
  ].join('\n');
}

/** Build an rdf:Seq nested element holding a single entry (v1 single-creator). */
export function seqBlock(qname: string, text: string): string {
  return [
    `  <${qname}>`,
    '   <rdf:Seq>',
    `    <rdf:li>${escapeXmlText(text)}</rdf:li>`,
    '   </rdf:Seq>',
    `  </${qname}>`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts
git commit -m "feat(xmp): lang-alt + seq RDF container helpers for metadata"
```

---

## Task 4: `XmpMetadata` type + simple-attribute field table

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp.types.ts`
- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`

- [ ] **Step 1: Add the types**

In `xmp.types.ts`, after the `XmpCulling` interface, add:

```typescript
/** Copyright status (`xmpRights:Marked`): tri-state. `unknown` omits the attribute. */
export type CopyrightStatus = 'unknown' | 'copyrighted' | 'public-domain';

/**
 * User-authored capture/IPTC metadata persisted to the XMP sidecar (Batch
 * Metadata, spec 2026-06-26). All fields optional; `null`/`undefined` mean
 * "not set" and emit nothing. Values are in native units (signed decimal
 * degrees, ISO-8601 datetime with offset, plain strings) — the standard-XMP
 * text encodings live in `xmp-metadata.ts`.
 */
export interface XmpMetadata {
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  gpsAltitude?: number | null;
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  sublocation?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  title?: string | null;
  caption?: string | null;
  headline?: string | null;
  instructions?: string | null;
  creator?: string | null;
  creatorJobTitle?: string | null;
  copyrightNotice?: string | null;
  copyrightStatus?: CopyrightStatus;
  usageTerms?: string | null;
  credit?: string | null;
  source?: string | null;
}
```

- [ ] **Step 2: Write the failing test**

Append to `xmp-metadata.spec.ts`:

```typescript
import { metadataAttrParts, METADATA_NAMESPACES } from './xmp-metadata';
import type { XmpMetadata } from './xmp.types';

describe('metadataAttrParts', () => {
  it('emits GPS, datetime, place, headline, and rights-marked attributes in order', () => {
    const m: XmpMetadata = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      gpsAltitude: 35,
      dateTimeOriginal: '2026-06-26T18:40:00+02:00',
      timeZone: 'Europe/Paris',
      city: 'Paris',
      country: 'France',
      countryCode: 'FR',
      headline: 'Trip',
      copyrightStatus: 'copyrighted',
    };
    expect(metadataAttrParts(m)).toEqual([
      'exif:GPSLatitude="48,51.3960N"',
      'exif:GPSLongitude="2,21.1320E"',
      'exif:GPSAltitude="35000/1000"',
      'exif:GPSAltitudeRef="0"',
      'exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"',
      'papp:TimeZone="Europe/Paris"',
      'photoshop:City="Paris"',
      'photoshop:Country="France"',
      'Iptc4xmpCore:CountryCode="FR"',
      'photoshop:Headline="Trip"',
      'xmpRights:Marked="True"',
    ]);
  });
  it('omits everything for an empty metadata object', () => {
    expect(metadataAttrParts({})).toEqual([]);
  });
  it('emits public-domain as Marked=False', () => {
    expect(metadataAttrParts({ copyrightStatus: 'public-domain' })).toEqual([
      'xmpRights:Marked="False"',
    ]);
  });
  it('omits Marked when status is unknown', () => {
    expect(metadataAttrParts({ copyrightStatus: 'unknown' })).toEqual([]);
  });
  it('escapes attribute values', () => {
    expect(metadataAttrParts({ city: 'A "B" & C' })).toEqual([
      'photoshop:City="A &quot;B&quot; &amp; C"',
    ]);
  });
});
```

- [ ] **Step 3: Write minimal implementation**

Append to `xmp-metadata.ts`:

```typescript
import type { XmpMetadata, CopyrightStatus } from './xmp.types';

/** Namespace declarations keyed by prefix (only emitted when used). */
export const METADATA_NAMESPACES: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
};

/** Attribute-content escaping (matches the serializer's `_escapeAttr`). */
function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const COPYRIGHT_TO_MARKED: Record<CopyrightStatus, string | null> = {
  unknown: null,
  copyrighted: 'True',
  'public-domain': 'False',
};

/**
 * Build the ordered list of simple-attribute parts for the metadata block
 * (the nested lang-alt/seq elements are handled separately in the serializer).
 * Order is fixed for per-platform byte-stability.
 */
export function metadataAttrParts(m: XmpMetadata): string[] {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}="${escapeXmlAttr(value)}"`);

  if (m.gpsLatitude != null) push('exif:GPSLatitude', gpsToXmp(m.gpsLatitude, 'lat'));
  if (m.gpsLongitude != null) push('exif:GPSLongitude', gpsToXmp(m.gpsLongitude, 'lon'));
  if (m.gpsAltitude != null) {
    const alt = altitudeToXmp(m.gpsAltitude);
    push('exif:GPSAltitude', alt.value);
    push('exif:GPSAltitudeRef', alt.ref);
  }
  if (m.dateTimeOriginal) push('exif:DateTimeOriginal', m.dateTimeOriginal);
  if (m.timeZone) push('papp:TimeZone', m.timeZone);
  if (m.sublocation) push('Iptc4xmpCore:Location', m.sublocation);
  if (m.city) push('photoshop:City', m.city);
  if (m.state) push('photoshop:State', m.state);
  if (m.country) push('photoshop:Country', m.country);
  if (m.countryCode) push('Iptc4xmpCore:CountryCode', m.countryCode);
  if (m.headline) push('photoshop:Headline', m.headline);
  if (m.instructions) push('photoshop:Instructions', m.instructions);
  if (m.creatorJobTitle) push('photoshop:AuthorsPosition', m.creatorJobTitle);
  if (m.credit) push('photoshop:Credit', m.credit);
  if (m.source) push('photoshop:Source', m.source);
  if (m.copyrightStatus) {
    const marked = COPYRIGHT_TO_MARKED[m.copyrightStatus];
    if (marked !== null) push('xmpRights:Marked', marked);
  }
  return parts;
}
```

Note: the import of `gpsToXmp`/`altitudeToXmp` is intra-module (same file) — no import line needed; only the `XmpMetadata`/`CopyrightStatus` type import is added at the top of the file's import section.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp.types.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts
git commit -m "feat(xmp): XmpMetadata type + ordered simple-attribute emitter"
```

---

## Task 5: Nested-element emitter + namespace computation

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `xmp-metadata.spec.ts`:

```typescript
import { metadataNestedBlocks, metadataNamespacePrefixes } from './xmp-metadata';

describe('metadataNestedBlocks', () => {
  it('emits title, creator, description, rights, usageTerms in order', () => {
    const blocks = metadataNestedBlocks({
      title: 'T',
      creator: 'C',
      caption: 'D',
      copyrightNotice: 'R',
      usageTerms: 'U',
    });
    expect(blocks.map((b) => b.split('\n')[0].trim())).toEqual([
      '<dc:title>',
      '<dc:creator>',
      '<dc:description>',
      '<dc:rights>',
      '<xmpRights:UsageTerms>',
    ]);
  });
  it('returns [] when no nested fields are set', () => {
    expect(metadataNestedBlocks({ city: 'Paris' })).toEqual([]);
  });
});

describe('metadataNamespacePrefixes', () => {
  it('reports exif + photoshop + Iptc4xmpCore for a place+gps edit', () => {
    expect(metadataNamespacePrefixes({ gpsLatitude: 1, city: 'X', countryCode: 'FR' })).toEqual(
      new Set(['exif', 'photoshop', 'Iptc4xmpCore']),
    );
  });
  it('reports dc for title and xmpRights for usageTerms', () => {
    expect(metadataNamespacePrefixes({ title: 'T', usageTerms: 'U' })).toEqual(
      new Set(['dc', 'xmpRights']),
    );
  });
  it('reports xmpRights for copyrightStatus=copyrighted', () => {
    expect(metadataNamespacePrefixes({ copyrightStatus: 'copyrighted' })).toEqual(
      new Set(['xmpRights']),
    );
  });
  it('reports nothing for copyrightStatus=unknown', () => {
    expect(metadataNamespacePrefixes({ copyrightStatus: 'unknown' })).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: FAIL — `metadataNestedBlocks`/`metadataNamespacePrefixes` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `xmp-metadata.ts`:

```typescript
/**
 * Build the nested lang-alt/seq element blocks for the metadata, in fixed
 * order (dc:title, dc:creator, dc:description, dc:rights, xmpRights:UsageTerms).
 * The `dc:subject` keyword bag is NOT here — it stays in the serializer's
 * culling path.
 */
export function metadataNestedBlocks(m: XmpMetadata): string[] {
  const blocks: string[] = [];
  if (m.title) blocks.push(langAltBlock('dc:title', m.title));
  if (m.creator) blocks.push(seqBlock('dc:creator', m.creator));
  if (m.caption) blocks.push(langAltBlock('dc:description', m.caption));
  if (m.copyrightNotice) blocks.push(langAltBlock('dc:rights', m.copyrightNotice));
  if (m.usageTerms) blocks.push(langAltBlock('xmpRights:UsageTerms', m.usageTerms));
  return blocks;
}

/**
 * Which namespace prefixes the metadata requires declared on rdf:Description.
 * Mirrors exactly what `metadataAttrParts` + `metadataNestedBlocks` emit.
 */
export function metadataNamespacePrefixes(m: XmpMetadata): Set<string> {
  const used = new Set<string>();
  if (
    m.gpsLatitude != null ||
    m.gpsLongitude != null ||
    m.gpsAltitude != null ||
    m.dateTimeOriginal
  )
    used.add('exif');
  if (
    m.city ||
    m.state ||
    m.country ||
    m.headline ||
    m.instructions ||
    m.creatorJobTitle ||
    m.credit ||
    m.source
  )
    used.add('photoshop');
  if (m.sublocation || m.countryCode) used.add('Iptc4xmpCore');
  if (m.title || m.creator || m.caption || m.copyrightNotice) used.add('dc');
  if (m.usageTerms) used.add('xmpRights');
  if (m.copyrightStatus && m.copyrightStatus !== 'unknown') used.add('xmpRights');
  return used;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=gps`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata.spec.ts
git commit -m "feat(xmp): nested-element emitter + namespace-prefix computation"
```

---

## Task 6: Serializer integration

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-serializer.service.ts:29-171`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata-roundtrip.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `xmp-metadata-roundtrip.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { XmpMetadata } from './xmp.types';

const ser = new XmpSerializerService();

describe('serialize with metadata', () => {
  it('declares only the used namespaces and emits attrs + nested in order', () => {
    const meta: XmpMetadata = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      city: 'Paris',
      title: 'Sunset',
      creator: 'Ansel Adams',
      copyrightNotice: '© 2026 Z. Lawrence',
    };
    const xml = ser.serialize(defaultAdjustmentModel(), undefined, undefined, meta);

    // namespaces
    expect(xml).toContain('xmlns:exif="http://ns.adobe.com/exif/1.0/"');
    expect(xml).toContain('xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).not.toContain('xmlns:xmpRights'); // none used here

    // attributes
    expect(xml).toContain('exif:GPSLatitude="48,51.3960N"');
    expect(xml).toContain('photoshop:City="Paris"');

    // nested, in order: title before creator before rights
    const iTitle = xml.indexOf('<dc:title>');
    const iCreator = xml.indexOf('<dc:creator>');
    const iRights = xml.indexOf('<dc:rights>');
    expect(iTitle).toBeGreaterThan(-1);
    expect(iCreator).toBeGreaterThan(iTitle);
    expect(iRights).toBeGreaterThan(iCreator);
  });

  it('emits no metadata namespaces or fields when metadata is omitted', () => {
    const xml = ser.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('xmlns:exif');
    expect(xml).not.toContain('exif:GPSLatitude');
  });

  it('coexists with keyword dc:subject (single dc namespace decl)', () => {
    const xml = ser.serialize(
      defaultAdjustmentModel(),
      undefined,
      { keywords: ['travel'] },
      {
        title: 'T',
      },
    );
    expect(xml).toContain('<dc:subject>');
    expect(xml).toContain('<dc:title>');
    // dc namespace declared exactly once
    expect(xml.match(/xmlns:dc=/g)?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=metadata` or `--filter=parseMetadata`)
Expected: FAIL — `serialize` has only 3 params; 4th `meta` arg ignored, namespaces/fields absent.

- [ ] **Step 3: Modify the serializer**

In `xmp-serializer.service.ts`, add the import near the top (after line 18):

```typescript
import type { XmpMetadata } from './xmp.types';
import {
  metadataAttrParts,
  metadataNestedBlocks,
  metadataNamespacePrefixes,
  METADATA_NAMESPACES,
} from './xmp-metadata';
```

Extend the method signature (line 29-39) — add the 4th parameter:

```typescript
  serialize(
    model: AdjustmentModel,
    passthrough?: PassthroughBucket,
    culling?: {
      rating?: number;
      flag?: Flag | string;
      colorLabel?: ColorLabel | string | null;
      keywords?: readonly string[];
    },
    metadata?: XmpMetadata,
  ): string {
```

Insert metadata attributes after the culling block and **before** the passthrough attribute loop (between current line 115 and line 117):

```typescript
// Metadata block — simple attributes (Batch Metadata, spec 2026-06-26).
// Inserted before passthrough so the fixed metadata order is stable.
if (metadata) {
  for (const part of metadataAttrParts(metadata)) {
    parts.push(part);
  }
}
```

Replace the `dcNamespaceLine` computation (lines 153-157) and the namespace lines in the return array (lines 159-171). First, compute the nested blocks and the namespace set. Replace lines 148-171 with:

```typescript
// Metadata nested elements (lang-alt / seq), in fixed order.
const metadataBlocks = metadata ? metadataNestedBlocks(metadata) : [];

// Compose nested children: metadata title/creator/description first, then
// keywords (dc:subject), then metadata rights/usageTerms, then any unknown
// passthrough nodes. We interleave by inserting the keyword block at its
// canonical slot: title, creator, description, [keywords], rights, usageTerms.
const titleCreatorDesc = metadataBlocks.filter((b) =>
  /^  <(dc:title|dc:creator|dc:description)>/.test(b),
);
const rightsUsage = metadataBlocks.filter((b) => /^  <(dc:rights|xmpRights:UsageTerms)>/.test(b));
const childBlocks = [
  titleCreatorDesc.join('\n'),
  keywordsBlock,
  rightsUsage.join('\n'),
  nestedNodes,
]
  .filter((b) => b.length > 0)
  .join('\n');
const nestedSection = childBlocks ? `\n${childBlocks}\n` : '\n';

// Namespace declarations: always xmp/crs/papp; then conditional metadata
// namespaces plus dc-for-keywords, in fixed prefix order.
const usedPrefixes = metadata ? metadataNamespacePrefixes(metadata) : new Set<string>();
if (keywords.length > 0) usedPrefixes.add('dc');
const NS_ORDER = ['dc', 'exif', 'photoshop', 'Iptc4xmpCore', 'xmpRights'];
const extraNsLines = NS_ORDER.filter((p) => usedPrefixes.has(p))
  .map((p) => `\n    xmlns:${p}="${METADATA_NAMESPACES[p]}"`)
  .join('');

return [
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Hosted 0.1.0">',
  ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '  <rdf:Description rdf:about=""',
  '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
  '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  `    xmlns:papp="http://ns.justmaple.app/photo/1.0/"${extraNsLines}`,
  `${attrsBlock}>${nestedSection}  </rdf:Description>`,
  ' </rdf:RDF>',
  '</x:xmpmeta>',
  '<?xpacket end="w"?>',
].join('\n');
```

> The existing `keywordsBlock` (lines 136-146) and `dcNamespaceLine` removal: delete the old `dcNamespaceLine` const entirely — the dc namespace is now handled by `usedPrefixes`. Keep `keywords` and `keywordsBlock` as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; the whole xmp suite must stay green)
Expected: PASS — new round-trip tests AND the existing `keywords.spec.ts` / `xmp-fields.spec.ts` still green (regression check).

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-serializer.service.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata-roundtrip.spec.ts
git commit -m "feat(xmp): serialize XmpMetadata block (attrs + nested + namespaces)"
```

---

## Task 7: Parser integration + passthrough exclusion + full round-trip

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts` (parse helpers)
- Modify: `src/web/projects/maple-common/src/lib/xmp/xmp-parser.service.ts`
- Test: `src/web/projects/maple-common/src/lib/xmp/xmp-metadata-roundtrip.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `xmp-metadata-roundtrip.spec.ts`:

```typescript
import { XmpParserService } from './xmp-parser.service';

const parser = new XmpParserService();

describe('parseMetadata round-trip', () => {
  const full: XmpMetadata = {
    gpsLatitude: 48.8566,
    gpsLongitude: 2.3522,
    gpsAltitude: 35,
    dateTimeOriginal: '2026-06-26T18:40:00+02:00',
    timeZone: 'Europe/Paris',
    sublocation: 'Rue Vignon',
    city: 'Paris',
    state: 'Île-de-France',
    country: 'France',
    countryCode: 'FR',
    title: 'Sunset',
    caption: 'Notes here & <there>',
    headline: 'Trip',
    instructions: 'Embargo until July',
    creator: 'Ansel Adams',
    creatorJobTitle: 'Photographer',
    copyrightNotice: '© 2026 Z. Lawrence',
    copyrightStatus: 'copyrighted',
    usageTerms: 'All rights reserved',
    credit: 'Z. Lawrence',
    source: 'Maple',
  };

  it('round-trips every field serialize -> parse', () => {
    const xml = ser.serialize(defaultAdjustmentModel(), undefined, undefined, full);
    const parsed = parser.parseMetadata(xml);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 4);
    expect(parsed.gpsLongitude).toBeCloseTo(2.3522, 4);
    expect(parsed.gpsAltitude).toBeCloseTo(35, 2);
    expect(parsed.dateTimeOriginal).toBe('2026-06-26T18:40:00+02:00');
    expect(parsed.timeZone).toBe('Europe/Paris');
    expect(parsed.sublocation).toBe('Rue Vignon');
    expect(parsed.city).toBe('Paris');
    expect(parsed.state).toBe('Île-de-France');
    expect(parsed.country).toBe('France');
    expect(parsed.countryCode).toBe('FR');
    expect(parsed.title).toBe('Sunset');
    expect(parsed.caption).toBe('Notes here & <there>');
    expect(parsed.headline).toBe('Trip');
    expect(parsed.instructions).toBe('Embargo until July');
    expect(parsed.creator).toBe('Ansel Adams');
    expect(parsed.creatorJobTitle).toBe('Photographer');
    expect(parsed.copyrightNotice).toBe('© 2026 Z. Lawrence');
    expect(parsed.copyrightStatus).toBe('copyrighted');
    expect(parsed.usageTerms).toBe('All rights reserved');
    expect(parsed.credit).toBe('Z. Lawrence');
    expect(parsed.source).toBe('Maple');
  });

  it('is byte-stable: serialize -> parse -> serialize is identical', () => {
    const xml1 = ser.serialize(defaultAdjustmentModel(), undefined, { keywords: ['travel'] }, full);
    const meta2 = parser.parseMetadata(xml1);
    const culling2 = parser.parseCulling(xml1);
    const { passthrough } = parser.parseAdjustmentModel(xml1);
    const xml2 = ser.serialize(
      defaultAdjustmentModel(),
      passthrough,
      { keywords: culling2.keywords },
      meta2,
    );
    expect(xml2).toBe(xml1);
  });

  it('does NOT double-emit managed nested elements via passthrough', () => {
    const xml1 = ser.serialize(defaultAdjustmentModel(), undefined, undefined, {
      title: 'T',
      creator: 'C',
      caption: 'D',
      copyrightNotice: 'R',
      usageTerms: 'U',
    });
    const { passthrough } = parser.parseAdjustmentModel(xml1);
    // None of the managed nested elements leak into passthrough nodes.
    const joined = passthrough.unknownNodes.join('');
    for (const tag of [
      'dc:title',
      'dc:creator',
      'dc:description',
      'dc:rights',
      'xmpRights:UsageTerms',
    ]) {
      expect(joined).not.toContain(tag);
    }
    // None of the managed attributes leak into passthrough attributes.
    const names = passthrough.unknownAttributes.map((a) => a.name);
    for (const key of ['exif:GPSLatitude', 'photoshop:City', 'xmpRights:Marked', 'papp:TimeZone']) {
      expect(names).not.toContain(key);
    }
  });

  it('leaves a genuinely-unknown node in passthrough untouched', () => {
    const src = ser.serialize(defaultAdjustmentModel(), {
      unknownAttributes: [],
      unknownNodes: [
        '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
      ],
    });
    const { passthrough } = parser.parseAdjustmentModel(src);
    expect(passthrough.unknownNodes.join('')).toContain('crs:ToneCurvePV2012');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; scope with `--filter=<describe-name>`, e.g. `--filter=metadata` or `--filter=parseMetadata`)
Expected: FAIL — `parser.parseMetadata` is not a function; managed fields appear in passthrough.

- [ ] **Step 3a: Add parse helpers to `xmp-metadata.ts`**

Append to `xmp-metadata.ts` (`CopyrightStatus` is already imported from Task 4 — do not re-import):

```typescript
const MARKED_TO_COPYRIGHT: Record<string, CopyrightStatus> = {
  True: 'copyrighted',
  False: 'public-domain',
};

/** Map `xmpRights:Marked` text to the tri-state; `null` for absent/unknown. */
export function copyrightStatusFromMarked(marked: string | null): CopyrightStatus | null {
  if (marked === null) return null;
  return MARKED_TO_COPYRIGHT[marked] ?? null;
}

/**
 * The managed metadata attribute keys (for KNOWN_ATTRIBUTES extension) and the
 * managed nested element local-names (for passthrough exclusion).
 */
export const METADATA_ATTR_KEYS: readonly string[] = [
  'exif:GPSLatitude',
  'exif:GPSLongitude',
  'exif:GPSAltitude',
  'exif:GPSAltitudeRef',
  'exif:DateTimeOriginal',
  'papp:TimeZone',
  'Iptc4xmpCore:Location',
  'photoshop:City',
  'photoshop:State',
  'photoshop:Country',
  'Iptc4xmpCore:CountryCode',
  'photoshop:Headline',
  'photoshop:Instructions',
  'photoshop:AuthorsPosition',
  'photoshop:Credit',
  'photoshop:Source',
  'xmpRights:Marked',
];

/** Managed nested elements `{ namespaceURI, localName }` — excluded from passthrough. */
export const METADATA_NESTED_ELEMENTS: ReadonlyArray<{ ns: string; local: string; tag: string }> = [
  { ns: METADATA_NAMESPACES['dc'], local: 'title', tag: 'dc:title' },
  { ns: METADATA_NAMESPACES['dc'], local: 'creator', tag: 'dc:creator' },
  { ns: METADATA_NAMESPACES['dc'], local: 'description', tag: 'dc:description' },
  { ns: METADATA_NAMESPACES['dc'], local: 'rights', tag: 'dc:rights' },
  { ns: METADATA_NAMESPACES['xmpRights'], local: 'UsageTerms', tag: 'xmpRights:UsageTerms' },
];
```

- [ ] **Step 3b: Add `parseMetadata` to `xmp-parser.service.ts`**

Add imports (after line 19):

```typescript
import type { XmpMetadata } from './xmp.types';
import {
  gpsFromXmp,
  altitudeFromXmp,
  copyrightStatusFromMarked,
  METADATA_ATTR_KEYS,
  METADATA_NESTED_ELEMENTS,
} from './xmp-metadata';
```

Extend `KNOWN_ATTRIBUTES` (inside the `new Set([...])`, before the closing `]`): add a spread of the metadata keys after the crop group:

```typescript
  // Batch Metadata block (spec 2026-06-26) — keep these out of passthrough.
  ...METADATA_ATTR_KEYS,
```

Add the `parseMetadata` method to the class (after `parseCulling`, before `parseAdjustmentModel`):

```typescript
  /**
   * Parse the IPTC/EXIF metadata block (Batch Metadata, spec 2026-06-26).
   * Returns only the fields present; absent fields are left undefined.
   */
  parseMetadata(xml: string): XmpMetadata {
    const result: XmpMetadata = {};
    let desc: Element | null = null;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parseerror')) return result;
      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');
    } catch {
      return result;
    }
    if (!desc) return result;

    // GPS
    const lat = this._attr(desc, ['exif:GPSLatitude']);
    if (lat !== null) {
      const v = gpsFromXmp(lat);
      if (v !== null) result.gpsLatitude = v;
    }
    const lon = this._attr(desc, ['exif:GPSLongitude']);
    if (lon !== null) {
      const v = gpsFromXmp(lon);
      if (v !== null) result.gpsLongitude = v;
    }
    const alt = this._attr(desc, ['exif:GPSAltitude']);
    if (alt !== null) {
      const v = altitudeFromXmp(alt, this._attr(desc, ['exif:GPSAltitudeRef']) ?? '0');
      if (v !== null) result.gpsAltitude = v;
    }

    // Simple string attributes.
    const str = (keys: string[]): string | undefined => {
      const v = this._attr(desc!, keys);
      return v === null ? undefined : v;
    };
    result.dateTimeOriginal = str(['exif:DateTimeOriginal']);
    result.timeZone = str(['papp:TimeZone']);
    result.sublocation = str(['Iptc4xmpCore:Location']);
    result.city = str(['photoshop:City']);
    result.state = str(['photoshop:State']);
    result.country = str(['photoshop:Country']);
    result.countryCode = str(['Iptc4xmpCore:CountryCode']);
    result.headline = str(['photoshop:Headline']);
    result.instructions = str(['photoshop:Instructions']);
    result.creatorJobTitle = str(['photoshop:AuthorsPosition']);
    result.credit = str(['photoshop:Credit']);
    result.source = str(['photoshop:Source']);

    const status = copyrightStatusFromMarked(this._attr(desc, ['xmpRights:Marked']));
    if (status !== null) result.copyrightStatus = status;

    // Nested lang-alt / seq elements → first rdf:li text content.
    result.title = this._nestedText(desc, 'http://purl.org/dc/elements/1.1/', 'title', 'dc:title');
    result.caption = this._nestedText(
      desc,
      'http://purl.org/dc/elements/1.1/',
      'description',
      'dc:description',
    );
    result.creator = this._nestedText(
      desc,
      'http://purl.org/dc/elements/1.1/',
      'creator',
      'dc:creator',
    );
    result.copyrightNotice = this._nestedText(
      desc,
      'http://purl.org/dc/elements/1.1/',
      'rights',
      'dc:rights',
    );
    result.usageTerms = this._nestedText(
      desc,
      'http://ns.adobe.com/xap/1.0/rights/',
      'UsageTerms',
      'xmpRights:UsageTerms',
    );

    // Strip undefined keys so an empty edit yields {} (byte-stable round-trip).
    for (const k of Object.keys(result) as (keyof XmpMetadata)[]) {
      if (result[k] === undefined) delete result[k];
    }
    return result;
  }

  /** First `rdf:li` text content of a nested lang-alt/seq element, or undefined. */
  private _nestedText(desc: Element, ns: string, local: string, qname: string): string | undefined {
    const elsNS = desc.getElementsByTagNameNS(ns, local);
    const el = elsNS.length > 0 ? elsNS[0] : desc.getElementsByTagName(qname)[0];
    if (!el) return undefined;
    const liNS = el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
    const li = liNS.length > 0 ? liNS[0] : el.getElementsByTagName('rdf:li')[0];
    const text = (li?.textContent ?? '').trim();
    return text.length > 0 ? text : undefined;
  }
```

Extend the passthrough nested-node exclusion (the loop at lines 409-417). Replace the `isDcSubject` check with a general managed-element check:

```typescript
const unknownNodes: string[] = [];
const isManaged = (child: Element): boolean => {
  // dc:subject (keywords) stays excluded as before.
  if (
    (child.namespaceURI === DC_NAMESPACE && child.localName === 'subject') ||
    child.tagName === 'dc:subject'
  ) {
    return true;
  }
  // Batch Metadata managed nested elements (spec 2026-06-26).
  return METADATA_NESTED_ELEMENTS.some(
    (e) => (child.namespaceURI === e.ns && child.localName === e.local) || child.tagName === e.tag,
  );
};
for (let i = 0; i < desc.children.length; i++) {
  const child = desc.children[i];
  if (isManaged(child)) continue;
  unknownNodes.push(child.outerHTML);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && bun x ng test Maple-common` (see "Running tests"; the whole xmp suite must stay green)
Expected: PASS — round-trip, byte-stable, no-double-emit, and the genuinely-unknown-node test all green; existing `keywords.spec.ts` + `xmp-fields.spec.ts` still pass.

- [ ] **Step 5: Format + full test sweep**

Run: `cd src/web && bun run format && bun x ng test Maple-common`
Expected: format clean; maple-common suite shows the new xmp tests passing with **no new failures** vs the known-red base (see "Running tests").

- [ ] **Step 6: Commit**

```bash
git add src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-parser.service.ts \
        src/web/projects/maple-common/src/lib/xmp/xmp-metadata-roundtrip.spec.ts
git commit -m "feat(xmp): parseMetadata + passthrough exclusion for metadata block

Closes the M0a TypeScript XMP metadata layer (round-trip, byte-stable,
no double-emit). Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md"
```

---

## Done criteria (M0a)

- `XmpMetadata` round-trips serialize → parse for all 21 fields.
- `serialize → parse → serialize` is byte-identical (per-platform byte-stable), including alongside keywords and passthrough nodes.
- Managed metadata attributes and nested elements never double-emit through passthrough; genuinely-unknown nodes still preserved verbatim.
- Only used namespaces are declared, in fixed order; the common no-metadata sidecar is byte-unchanged from today.
- `bun run format:check` clean; maple-common suite green with no new failures.

## Follow-on plans (not in M0a)

- **M0b:** Swift XMP metadata layer (mirror `XmpMetadata`), Rust tolerance test, cross-platform **semantic** parity tests, codegen for shared constants (namespace URIs, copyright-status mapping).
- **KTLO debt ticket:** TS↔Swift byte-canonical harmonization (papp: URI, namespace order, attribute sort, indentation).
- **M1+:** API (`POST /api/xmp/batch`, `override-ingest` stage, `GET /api/geocode/search`, effective resolver), Web UI, Apple UI, backup re-file, video.
