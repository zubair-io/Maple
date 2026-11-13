import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from './mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteXmpSidecar, writeXmpAtomic, writeXmpWithPrecondition } from './xmp.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const MAPLE = 'http://ns.justmaple.app/photo/1.0/';
const sidecar = (attributes: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}"><rdf:Description xmlns:papp="${MAPLE}" xmlns:foo="urn:foo" ${attributes}/></rdf:RDF></x:xmpmeta>`;

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-sidecar-lease-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await fs.chmod(join(root, 'x.xmp'), 0o600).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

const lockFiles = async () => (await fs.readdir(root)).filter((name) => name.endsWith('.lock'));

test('deleting the sidecar of a photo whose folder is gone does not recreate the folder', async () => {
  await fs.mkdir(join(root, 'Gone'));
  await fs.rm(join(root, 'Gone'), { recursive: true });
  await deleteXmpSidecar(join(root, 'Gone', 'x.dng'));
  await expect(fs.lstat(join(root, 'Gone'))).rejects.toThrow();
});

test('an ordinary save leaves no coordination files beside a photo without removal records', async () => {
  await fs.writeFile(join(root, 'x.dng'), 'raw');
  await fs.writeFile(
    join(root, 'x.xmp'),
    sidecar('foo:Note="mentions InpaintRemovals in passing"'),
  );
  const result = await writeXmpAtomic(join(root, 'x.dng'), sidecar('papp:Exposure="1"'));
  expect(result.ok).toBe(true);
  expect(await lockFiles()).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  'an unreadable sidecar takes the ordinary write path and creates no coordination files',
  async () => {
    await fs.writeFile(join(root, 'x.dng'), 'raw');
    await fs.writeFile(join(root, 'x.xmp'), sidecar('papp:Exposure="1"'));
    await fs.chmod(join(root, 'x.xmp'), 0o000);
    await writeXmpAtomic(join(root, 'x.dng'), sidecar('papp:Exposure="2"'));
    expect(await lockFiles()).toEqual([]);
  },
);

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'a legacy precondition save cannot strip accepted removal records; it becomes a conflict copy',
  async () => {
    await fs.writeFile(join(root, 'x.dng'), 'raw');
    const accepted = sidecar(`papp:InpaintRemovals='[{"id":1}]'`);
    await fs.writeFile(join(root, 'x.xmp'), accepted);
    const outcome = await writeXmpWithPrecondition(
      join(root, 'x.dng'),
      sidecar('papp:Exposure="2"'),
      null,
      'iPad',
    );
    expect(outcome.kind).toBe('conflict');
    expect(await fs.readFile(join(root, 'x.xmp'), 'utf8')).toBe(accepted);
  },
);
