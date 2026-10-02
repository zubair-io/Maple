/** #3984: real HTTP parsing, real sidecars/companions, real native children. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../fs/mirrored.ts';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { maple } from 'maple';
import { authedApi } from './authed-api.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { removalRelocationLease } from '../fs/removal-relocation-lease.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
const app = new Elysia().use(authedApi);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const originalSecret = process.env.MAPLE_JWT_SECRET;

describe.skipIf(!nativeLibAvailable())('Self Hosted removal publication (#3984)', () => {
  let root: string;
  let raw: string;
  let xmp: string;
  let xml: string;
  let records: string;
  let mask: string;
  let patch: string;
  let token: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-api-authoring-')));
    registerRoot(root);
    setLibraryRootsForTests(new Map([['removal-authoring-test', root]]));
    process.env.MAPLE_JWT_SECRET = 'local-removal-authoring-test-secret';
    token = await signAccessToken(
      { sub: 'author', email: null, role: 'owner', file_access: true },
      process.env.MAPLE_JWT_SECRET,
    );
    raw = join(root, 'photo.dng');
    xmp = join(root, 'photo.xmp');
    await fs.copyFile(join(fixture, 'source.dng'), raw);
    xml = await fs.readFile(join(fixture, 'saved.xmp'), 'utf8');
    records = await fs.readFile(join(fixture, 'records.txt'), 'utf8');
    const [record] = JSON.parse(records);
    mask = `${record.accepted.mask.slice(7)}.mask`;
    patch = `${record.patch.slice(7)}.f16`;
  });
  afterEach(async () => {
    unregisterRoot(root);
    setLibraryRootsForTests(null);
    if (originalSecret === undefined) delete process.env.MAPLE_JWT_SECRET;
    else process.env.MAPLE_JWT_SECRET = originalSecret;
    await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(() => ffiPool().shutdown());

  function request(
    route: string,
    method = 'GET',
    body?: string | Uint8Array,
    name?: string,
    source = raw,
    bearer: string | null = token,
  ) {
    const query = new URLSearchParams({ path: source, ...(name ? { name } : {}) });
    return app.handle(
      new Request(`http://localhost/api/removal/${route}?${query}`, {
        method,
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(body
            ? {
                'Content-Type':
                  typeof body === 'string' ? 'application/json' : 'application/octet-stream',
              }
            : {}),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : new Uint8Array(body).buffer }),
      }),
    );
  }
  async function upload(name: string, fixtureName: string) {
    return request('companion', 'PUT', await fs.readFile(join(fixture, fixtureName)), name);
  }
  async function publishAssets() {
    expect((await upload(mask, 'mask.mimf')).status).toBe(200);
    expect((await upload(patch, 'patch.f16')).status).toBe(200);
  }
  function commit(document = xml, expectedRevision = 'missing', expectedRecords = '[]') {
    return request(
      'xmp',
      'POST',
      JSON.stringify({ xml: document, expectedRevision, expectedRecords }),
    );
  }

  it('publishes immutable companions before XMP, confirms exact bytes and reproduces saved pixels', async () => {
    const original = digest(await fs.readFile(raw));
    const snapshot = await request('xmp');
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('cache-control')).toBe('private, no-store');
    expect(await snapshot.json()).toEqual({ revision: 'missing', xml: '' });
    await publishAssets();
    await expect(fs.stat(xmp)).rejects.toThrow();
    const saved = await commit();
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: digest(Buffer.from(xml)), xml });
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    const coldRead = await request('companion', 'GET', undefined, patch);
    expect(coldRead.status).toBe(200);
    expect(coldRead.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await coldRead.arrayBuffer())).toEqual(
      await fs.readFile(join(fixture, 'patch.f16')),
    );
    const out = join(root, 'confirmed.png');
    expect(
      await ffiPool().exportRecipeToFile(
        raw,
        xml,
        JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, format: 'png', quality: null }),
        null,
        out,
      ),
    ).toBe(true);
    expect(Buffer.from((await maple(out).toRaw()).data)).toEqual(
      await fs.readFile(join(fixture, 'preview-64.rgb')),
    );
    expect(digest(await fs.readFile(raw))).toBe(original);
    expect((await fs.readdir(join(root, '.maple/inpaint'))).sort()).toEqual([mask, patch].sort());
  });

  it('allows exact companion retries and rejects corrupt uploads without replacing accepted bytes', async () => {
    await publishAssets();
    expect((await upload(patch, 'patch.f16')).status).toBe(200);
    const bytes = await fs.readFile(join(root, '.maple/inpaint', patch));
    const response = await request('companion', 'PUT', Buffer.from('corrupt'), patch);
    expect(response.status).toBe(422);
    expect(await fs.readFile(join(root, '.maple/inpaint', patch))).toEqual(bytes);
    expect((await fs.readdir(join(root, '.maple/inpaint'))).sort()).toEqual([mask, patch].sort());
  });

  it('publishes concurrent identical companion uploads once and rejects an empty upload', async () => {
    const responses = await Promise.all([upload(mask, 'mask.mimf'), upload(mask, 'mask.mimf')]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await fs.readdir(join(root, '.maple/inpaint'))).toEqual([mask]);
    expect((await request('companion', 'PUT', new Uint8Array(), patch)).status).toBe(422);
    expect(await fs.readdir(join(root, '.maple/inpaint'))).toEqual([mask]);
  });

  it('permits independent photos to create and share the same immutable companion directory', async () => {
    const other = join(root, 'other.dng');
    await fs.copyFile(raw, other);
    const bytes = await fs.readFile(join(fixture, 'mask.mimf'));
    const responses = await Promise.all([
      request('companion', 'PUT', bytes, mask),
      request('companion', 'PUT', bytes, mask, other),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await fs.readdir(join(root, '.maple/inpaint'))).toEqual([mask]);
    expect(await fs.readFile(other)).toEqual(await fs.readFile(raw));
  });

  it('recovers a lost commit acknowledgement only while the exact postcondition still holds', async () => {
    await publishAssets();
    expect((await commit()).status).toBe(200);
    expect((await commit()).status).toBe(200);
    const later = xml.replace('rdf:Description', 'rdf:Description foreign="later"');
    await fs.writeFile(xmp, later);
    expect((await commit()).status).toBe(409);
    expect(await fs.readFile(xmp, 'utf8')).toBe(later);
  });

  it('rejects truncated native record transport on an acknowledgement retry', async () => {
    await publishAssets();
    expect((await commit()).status).toBe(200);
    expect((await commit(xml, 'missing', '[]\0ignored')).status).toBe(422);
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
  });

  it('rejects a stale whole-document revision, including a foreign-field-only change', async () => {
    await publishAssets();
    const prior = xml.replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"');
    await fs.writeFile(xmp, prior);
    const captured = await (await request('xmp')).json();
    const changed = prior.replace('rdf:Description', 'rdf:Description foreign="another editor"');
    await fs.writeFile(xmp, changed);
    expect((await commit(xml, captured.revision)).status).toBe(409);
    expect(await fs.readFile(xmp, 'utf8')).toBe(changed);
  });

  it('serializes two competing XMP commits and confirms only the winner', async () => {
    await publishAssets();
    const variant = xml.replace('rdf:Description', 'rdf:Description foreign="second"');
    const responses = await Promise.all([commit(), commit(variant)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((r) => r.status === 200);
    expect(await fs.readFile(xmp, 'utf8')).toBe(winner === 0 ? xml : variant);
  });

  for (const failure of [
    'missing-patch',
    'corrupt-mask',
    'changed-original',
    'future-schema',
    'malformed-xml',
    'wrong-prior',
  ] as const)
    it(`${failure} refuses Keep and retains the previous XMP`, async () => {
      await publishAssets();
      const prior = xml.replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"');
      await fs.writeFile(xmp, prior);
      const captured = await (await request('xmp')).json();
      if (failure === 'missing-patch') await fs.rm(join(root, '.maple/inpaint', patch));
      if (failure === 'corrupt-mask')
        await fs.writeFile(join(root, '.maple/inpaint', mask), 'corrupt');
      if (failure === 'changed-original') await fs.appendFile(raw, Buffer.from([0]));
      const next =
        failure === 'future-schema'
          ? xml.replace('&quot;schema&quot;:4', '&quot;schema&quot;:99')
          : failure === 'malformed-xml'
            ? '<invalid'
            : xml;
      const response = await commit(
        next,
        captured.revision,
        failure === 'wrong-prior' ? records : '[]',
      );
      expect(response.status).toBe(
        failure === 'missing-patch' ? 404 : failure === 'wrong-prior' ? 409 : 422,
      );
      expect(await fs.readFile(xmp, 'utf8')).toBe(prior);
    });

  it('permits Clear with lost old companions, preserving foreign XML and the original', async () => {
    await fs.writeFile(xmp, xml);
    const prior = await (await request('xmp')).json();
    const cleared = xml
      .replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"')
      .replace('rdf:Description', 'rdf:Description foreign="retained"');
    const response = await commit(cleared, prior.revision, records);
    expect(response.status).toBe(200);
    expect(await fs.readFile(xmp, 'utf8')).toBe(cleared);
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
  });

  it('keeps disabled schema-5 assets so confirmed history can re-enable and clear them', async () => {
    await publishAssets();
    const [record] = JSON.parse(records);
    const active = { ...record, schema: 5, id: record.patch, active: true };
    const activeRecords = JSON.stringify([active]);
    const disabledRecords = JSON.stringify([{ ...active, active: false }]);
    const document = (value: string) =>
      xml.replace(
        /papp:InpaintRemovals="[^"]*"/,
        `papp:InpaintRemovals="${value.replaceAll('"', '&quot;')}"`,
      );
    const disabled = document(disabledRecords);
    expect((await commit(disabled)).status).toBe(200);
    const enabled = document(activeRecords);
    expect((await commit(enabled, digest(Buffer.from(disabled)), disabledRecords)).status).toBe(
      200,
    );
    const cleared = document('[]');
    expect((await commit(cleared, digest(Buffer.from(enabled)), activeRecords)).status).toBe(200);
    expect(await fs.readFile(xmp, 'utf8')).toBe(cleared);
    expect((await fs.readdir(join(root, '.maple/inpaint'))).sort()).toEqual([mask, patch].sort());
  });

  it('refuses Clear when the original identity changed, even with old assets missing', async () => {
    await fs.writeFile(xmp, xml);
    const captured = await (await request('xmp')).json();
    await fs.appendFile(raw, Buffer.from([0]));
    const cleared = xml.replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"');
    expect((await commit(cleared, captured.revision, records)).status).toBe(422);
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
  });

  it('never replaces malformed current XMP or follows a sidecar link', async () => {
    await publishAssets();
    const malformed = '<invalid';
    await fs.writeFile(xmp, malformed);
    expect((await commit(xml, digest(Buffer.from(malformed)))).status).toBe(422);
    expect(await fs.readFile(xmp, 'utf8')).toBe(malformed);
    await fs.rm(xmp);
    const elsewhere = join(root, 'foreign.xmp');
    await fs.writeFile(elsewhere, xml);
    await fs.symlink(elsewhere, xmp);
    expect((await request('xmp')).status).toBe(409);
    expect((await commit()).status).toBe(409);
    expect(await fs.readFile(elsewhere, 'utf8')).toBe(xml);
  });

  it('rejects an occupied corrupt immutable asset without replacing it', async () => {
    await fs.mkdir(join(root, '.maple/inpaint'), { recursive: true });
    const path = join(root, '.maple/inpaint', patch);
    await fs.writeFile(path, 'previous corrupt occupant');
    expect((await upload(patch, 'patch.f16')).status).toBe(422);
    expect(await fs.readFile(path, 'utf8')).toBe('previous corrupt occupant');
  });

  it('refuses companion directory and file symlinks for both reads and writes', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'maple-removal-outside-'));
    try {
      await fs.symlink(outside, join(root, '.maple'));
      expect((await upload(patch, 'patch.f16')).status).toBe(409);
      expect((await request('companion', 'GET', undefined, patch)).status).toBe(409);
      expect(await fs.readdir(outside)).toEqual([]);
      await fs.rm(join(root, '.maple'));
      await fs.mkdir(join(root, '.maple/inpaint'), { recursive: true });
      await fs.copyFile(join(fixture, 'patch.f16'), join(outside, 'patch'));
      await fs.symlink(join(outside, 'patch'), join(root, '.maple/inpaint', patch));
      expect((await upload(patch, 'patch.f16')).status).toBe(409);
      expect((await request('companion', 'GET', undefined, patch)).status).toBe(409);
      expect(await fs.readFile(join(outside, 'patch'))).toEqual(
        await fs.readFile(join(fixture, 'patch.f16')),
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('requires bearer authentication, confines names/paths, and rejects non-RAW sources', async () => {
    expect((await request('xmp', 'GET', undefined, undefined, raw, null)).status).toBe(401);
    expect((await request('companion', 'PUT', Buffer.from('bad'), patch, raw, null)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          'xmp',
          'POST',
          JSON.stringify({ expectedRevision: 'missing', expectedRecords: '[]', xml }),
          undefined,
          raw,
          null,
        )
      ).status,
    ).toBe(401);
    expect((await request('companion', 'GET', undefined, '../escape')).status).toBe(400);
    expect((await request('xmp', 'GET', undefined, undefined, '/outside/photo.dng')).status).toBe(
      403,
    );
    expect(
      (await request('xmp', 'GET', undefined, undefined, join(root, 'photo.jpg'))).status,
    ).toBe(415);
    expect(
      (await request('xmp', 'GET', undefined, undefined, join(root, 'missing.dng'))).status,
    ).toBe(404);
    await expect(fs.stat(xmp)).rejects.toThrow();
  });

  it('addresses literal percent, plus and Unicode filenames without a second URL decode', async () => {
    const literal = join(root, 'photo %20 + 照片.dng');
    const decoded = join(root, 'photo   + 照片.dng');
    await fs.copyFile(raw, literal);
    await fs.copyFile(raw, decoded);
    const prior = xml.replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"');
    await fs.writeFile(literal.replace('.dng', '.xmp'), prior);
    const response = await request('xmp', 'GET', undefined, undefined, literal);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: digest(Buffer.from(prior)), xml: prior });
    const uploaded = await request(
      'companion',
      'PUT',
      await fs.readFile(join(fixture, 'mask.mimf')),
      mask,
      literal,
    );
    expect(uploaded.status).toBe(200);
    const cleared = prior.replace('rdf:Description', 'rdf:Description foreign="literal path"');
    const saved = await request(
      'xmp',
      'POST',
      JSON.stringify({
        expectedRevision: digest(Buffer.from(prior)),
        expectedRecords: '[]',
        xml: cleared,
      }),
      undefined,
      literal,
    );
    expect(saved.status).toBe(200);
    expect(await fs.readFile(literal.replace('.dng', '.xmp'), 'utf8')).toBe(cleared);
    await expect(fs.stat(decoded.replace('.dng', '.xmp'))).rejects.toThrow();
  });

  it('does not publish while a native/relocation owner holds the source lease', async () => {
    const lease = await removalRelocationLease(raw, raw);
    try {
      const response = await upload(mask, 'mask.mimf');
      expect(response.status).toBe(500);
      await expect(fs.stat(join(root, '.maple/inpaint', mask))).rejects.toThrow();
      await expect(fs.stat(xmp)).rejects.toThrow();
    } finally {
      await lease.release();
    }
  });

  it('ordinary full-document saves preserve accepted history and cannot bypass its confirmed commit', async () => {
    const ordinary = (document: string) =>
      app.handle(
        new Request(`http://localhost/api/xmp?${new URLSearchParams({ path: raw })}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/xml' },
          body: document,
        }),
      );
    await publishAssets();
    expect((await ordinary(xml)).status).toBe(409);
    await expect(fs.stat(xmp)).rejects.toThrow();
    expect((await commit()).status).toBe(200);
    const cleared = xml.replace(/papp:InpaintRemovals="[^"]*"/, 'papp:InpaintRemovals="[]"');
    expect((await ordinary(cleared)).status).toBe(409);
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    const metadata = xml.replace('rdf:Description', 'rdf:Description foreign="metadata"');
    expect((await ordinary(metadata)).status).toBe(200);
    expect(await fs.readFile(xmp, 'utf8')).toBe(metadata);
  });
});
