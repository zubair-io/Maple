/**
 * Temp files a server crash leaves beside a relocation's destination (#5136).
 * The crashes are real: a child process runs the relocation and kills itself
 * with SIGKILL at the step under test, so what is left behind is exactly what a
 * dead server leaves. Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepCrashLeftTemps } from './crash-left-temps.ts';
import * as fs from './mirrored.ts';
import { privateSiblingOf, VERIFYING_COPY_MARKER } from './private-sibling.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-left-temps-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => fs.readFile(abs(rel), 'utf8').catch(() => null);
async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const names = async (rel: string) => (await fs.readdir(abs(rel))).sort();
const tempNames = async (rel: string) => (await names(rel)).filter((n) => n.includes('.tmp.'));
const sweep = async (rel: string) =>
  sweepCrashLeftTemps(abs(rel), await fs.readdir(abs(rel), { withFileTypes: true }));

async function ageTemps(rel: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  for (const name of await tempNames(rel)) await fs.utimes(abs(`${rel}/${name}`), when, when);
}

const crashScript = () => `
import { spyOn } from 'bun:test';
import * as fs from ${JSON.stringify(path.join(import.meta.dir, 'mirrored.ts'))};
import { relocateFile } from ${JSON.stringify(path.join(import.meta.dir, 'relocate.ts'))};
const [, , step, sourceAbsPath, destAbsPath] = process.argv;
const die = () => process.kill(process.pid, 'SIGKILL');
const realUnlink = fs.unlink;
const realRename = fs.rename;
if (step === 'before-publish') spyOn(fs, 'link').mockImplementation(async () => die());
if (step === 'after-publish') {
  spyOn(fs, 'unlink').mockImplementation(async (file) => {
    if (String(file).includes('.tmp.')) die();
    return realUnlink(file);
  });
}
if (step === 'before-swap') {
  spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('.tmp.')) die();
    return realRename(from, to);
  });
}
await relocateFile({
  sourceAbsPath,
  destAbsPath,
  mode: 'move',
  collision: step.endsWith('swap') ? 'replace' : 'skip',
  onVerified: step === 'after-swap' ? async () => die() : undefined,
});
`;

async function crashRelocation(step: string): Promise<void> {
  const script = abs('crash-relocation.ts');
  await fs.writeFile(script, crashScript());
  const child = Bun.spawn(
    [process.execPath, script, step, abs('src/IMG.CR3'), abs('dst/IMG.CR3')],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  await child.exited;
  expect(child.signalCode, await new Response(child.stderr).text()).toBe('SIGKILL');
}

describe('a relocation killed mid-way', () => {
  test('a verifying copy left before the publish is removed once abandoned', async () => {
    await write('src/IMG.CR3', 'pixels');
    await crashRelocation('before-publish');
    expect(await tempNames('dst')).toHaveLength(1);

    expect(await sweep('dst')).toBe(0);
    await ageTemps('dst', 2 * DAY_MS);
    expect(await sweep('dst')).toBe(1);

    expect(await names('dst')).toEqual([]);
    expect(await read('src/IMG.CR3')).toBe('pixels');
  });

  test('a verifying copy still hard-linked to the published photo is removed, the photo stays', async () => {
    await write('src/IMG.CR3', 'pixels');
    await crashRelocation('after-publish');
    expect(await tempNames('dst')).toHaveLength(1);
    expect(await read('dst/IMG.CR3')).toBe('pixels');

    await ageTemps('dst', 2 * DAY_MS);
    expect(await sweep('dst')).toBe(1);

    expect(await names('dst')).toEqual(['IMG.CR3']);
    expect(await read('dst/IMG.CR3')).toBe('pixels');
  });

  test('a Replace killed before its swap leaves nothing that is not a second name for a kept file', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await crashRelocation('before-swap');
    expect(await tempNames('dst')).toHaveLength(2);

    await ageTemps('dst', 2 * DAY_MS);
    expect(await sweep('dst')).toBe(2);

    expect(await names('dst')).toEqual(['IMG.CR3']);
    expect(await read('dst/IMG.CR3')).toBe('old');
    expect(await read('src/IMG.CR3')).toBe('new');
  });

  test('a Replace killed after its swap keeps the displaced photo, the only copy of it', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await crashRelocation('after-swap');
    const kept = await tempNames('dst');
    expect(kept).toHaveLength(1);

    await ageTemps('dst', 30 * DAY_MS);
    expect(await sweep('dst')).toBe(0);

    expect(await read('dst/IMG.CR3')).toBe('new');
    expect(await read(`dst/${kept[0]}`)).toBe('old');
  });
});

describe('what the sweep never touches', () => {
  const longAgo = 2 * DAY_MS;

  test('a temp that has not been idle for a day', async () => {
    await write('dst/IMG.CR3', 'pixels');
    await write(
      `dst/${path.basename(privateSiblingOf(abs('dst/IMG.CR3'), VERIFYING_COPY_MARKER))}`,
      'x',
    );
    await ageTemps('dst', DAY_MS / 2);

    expect(await sweep('dst')).toBe(0);
    expect(await tempNames('dst')).toHaveLength(1);
  });

  test('a temp this process owns', async () => {
    const own = path.basename(privateSiblingOf(abs('dst/IMG.CR3'), VERIFYING_COPY_MARKER));
    await write(`dst/${own}`, 'in flight');
    await ageTemps('dst', longAgo);

    expect(await sweep('dst')).toBe(0);
    expect(await names('dst')).toEqual([own]);
  });

  test('an unmarked temp that is not a second name for the file beside it', async () => {
    await write('dst/IMG.CR3', 'new');
    await write('dst/IMG.CR3.tmp.99999999-0123456789abcdef', 'the only copy');
    await write('dst/IMG.xmp.tmp.99999999-0123456789abcdef', 'an aside, with its base gone');
    await ageTemps('dst', longAgo);

    expect(await sweep('dst')).toBe(0);
    expect(await tempNames('dst')).toHaveLength(2);
  });

  test('a file that only looks like a temp', async () => {
    const lookalikes = [
      'IMG.tmp.JPG',
      'IMG.tmp.123.JPG',
      'IMG.JPG.tmp.99999999-xyz.copy',
      'IMG.JPG.tmp.99999999.0123456789abcdef.copy',
      'IMG.JPG.tmp.copy',
    ];
    for (const name of lookalikes) await write(`dst/${name}`, 'photo');
    const when = new Date(Date.now() - longAgo);
    for (const name of lookalikes) await fs.utimes(abs(`dst/${name}`), when, when);

    expect(await sweep('dst')).toBe(0);
    expect(await names('dst')).toEqual(lookalikes.toSorted());
  });

  test('a marked temp that is a directory', async () => {
    await fs.mkdir(abs('dst/IMG.CR3.tmp.99999999-0123456789abcdef.copy'), { recursive: true });
    await write('dst/IMG.CR3.tmp.99999999-0123456789abcdef.copy/inside.txt', 'x');
    await ageTemps('dst', longAgo);

    expect(await sweep('dst')).toBe(0);
    expect(await read('dst/IMG.CR3.tmp.99999999-0123456789abcdef.copy/inside.txt')).toBe('x');
  });
});

describe('a verifying copy of a long file name', () => {
  test('is the short hidden form and is removed once abandoned', async () => {
    const long = `${'a'.repeat(250)}.CR3`;
    const hidden = path.basename(privateSiblingOf(abs(`dst/${long}`), VERIFYING_COPY_MARKER));
    expect(hidden.startsWith('.tmp.')).toBe(true);
    await write(`dst/${hidden.replace(String(process.pid), '99999999')}`, 'partial');
    await ageTemps('dst', 2 * DAY_MS);

    expect(await sweep('dst')).toBe(1);
    expect(await names('dst')).toEqual([]);
  });
});
