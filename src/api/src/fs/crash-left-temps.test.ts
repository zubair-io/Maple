/**
 * Files a server crash leaves beside a relocation's destination (#5136, #5786).
 * The crashes are real: a child process runs the relocation and kills itself
 * with SIGKILL at the step under test, so what is left behind is exactly what a
 * dead server leaves. Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepCrashLeftTemps } from './crash-left-temps.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import * as fs from './mirrored.ts';
import {
  DISPLACED_MARKER,
  parsePrivateSibling,
  privateSiblingOf,
  VERIFYING_COPY_MARKER,
} from './private-sibling.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-left-temps-'));
});
afterEach(async () => {
  setSystemTime();
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
const deadPid = (name: string) => name.replace(String(process.pid), '99999999');

/** Sweeps `rel` as it looks `idleFor` after the files were last touched. */
async function sweep(rel: string, idleFor = 2 * DAY_MS) {
  const entries = await fs.readdir(abs(rel), { withFileTypes: true });
  setSystemTime(new Date(Date.now() + idleFor));
  try {
    return await sweepCrashLeftTemps(abs(rel), entries);
  } finally {
    setSystemTime();
  }
}

const crashScript = () => `
import { spyOn } from 'bun:test';
import * as fs from ${JSON.stringify(path.join(import.meta.dir, 'mirrored.ts'))};
import { relocateFile } from ${JSON.stringify(path.join(import.meta.dir, 'relocate.ts'))};
const [, , step, sourceAbsPath, destAbsPath] = process.argv;
const die = () => process.kill(process.pid, 'SIGKILL');
const realUnlink = fs.unlink;
const realRename = fs.rename;
const noLinks = step.endsWith('-nolinks');
const at = step.replace('-nolinks', '');
if (noLinks) {
  spyOn(fs, 'link').mockImplementation(async () => {
    throw Object.assign(new Error('no hard links here'), { code: 'EXDEV' });
  });
}
if (at === 'before-publish') spyOn(fs, 'link').mockImplementation(async () => die());
if (at === 'after-publish') {
  spyOn(fs, 'unlink').mockImplementation(async (file) => {
    if (String(file).includes('.tmp.')) die();
    return realUnlink(file);
  });
}
if (at === 'before-swap') {
  spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('.tmp.')) die();
    return realRename(from, to);
  });
}
await relocateFile({
  sourceAbsPath,
  destAbsPath,
  mode: 'move',
  collision: at.endsWith('swap') ? 'replace' : 'skip',
  onVerified: at === 'after-swap' ? async () => die() : undefined,
});
`;

async function crashRelocation(step: string, name = 'IMG.CR3'): Promise<void> {
  const script = abs('crash-relocation.ts');
  await fs.writeFile(script, crashScript());
  const child = Bun.spawn(
    [process.execPath, script, step, abs(`src/${name}`), abs(`dst/${name}`)],
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

    expect(await sweep('dst', DAY_MS / 2)).toEqual({ removed: 0, surfaced: 0 });
    expect(await sweep('dst')).toEqual({ removed: 1, surfaced: 0 });

    expect(await names('dst')).toEqual([]);
    expect(await read('src/IMG.CR3')).toBe('pixels');
  });

  test('a verifying copy still hard-linked to the published photo is removed, the photo stays', async () => {
    await write('src/IMG.CR3', 'pixels');
    await crashRelocation('after-publish');
    expect(await tempNames('dst')).toHaveLength(1);
    expect(await read('dst/IMG.CR3')).toBe('pixels');

    expect(await sweep('dst')).toEqual({ removed: 1, surfaced: 0 });

    expect(await names('dst')).toEqual(['IMG.CR3']);
    expect(await read('dst/IMG.CR3')).toBe('pixels');
  });

  test('a Replace killed before its swap leaves nothing that is not a second name for a kept file', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await crashRelocation('before-swap');
    expect(await tempNames('dst')).toHaveLength(2);

    expect(await sweep('dst')).toEqual({ removed: 2, surfaced: 0 });

    expect(await names('dst')).toEqual(['IMG.CR3']);
    expect(await read('dst/IMG.CR3')).toBe('old');
    expect(await read('src/IMG.CR3')).toBe('new');
  });

  test('on a volume without hard links, a kept copy of the occupant is removed when the occupant is still there', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await crashRelocation('before-swap-nolinks');
    expect(await tempNames('dst')).toHaveLength(2);

    expect(await sweep('dst')).toEqual({ removed: 2, surfaced: 0 });

    expect(await names('dst')).toEqual(['IMG.CR3']);
    expect(await read('dst/IMG.CR3')).toBe('old');
  });

  for (const links of ['', '-nolinks']) {
    test(`a Replace killed after its swap${links ? ' without hard links' : ''} publishes the displaced photo under a visible name`, async () => {
      await write('src/IMG.CR3', 'new');
      await write('dst/IMG.CR3', 'old');
      await crashRelocation(`after-swap${links}`);
      expect(await tempNames('dst')).toHaveLength(1);

      expect(await sweep('dst', DAY_MS / 2)).toEqual({ removed: 0, surfaced: 0 });
      expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 1 });

      expect(await names('dst')).toEqual(['IMG (replaced).CR3', 'IMG.CR3']);
      expect(await read('dst/IMG.CR3')).toBe('new');
      expect(await read('dst/IMG (replaced).CR3')).toBe('old');
      expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 0 });
    });
  }

  test('a Replace killed after its swap surfaces the displaced sidecar as a conflict copy of the photo', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await write('dst/IMG.xmp', 'old edits');
    await crashRelocation('after-swap');
    expect(await tempNames('dst')).toHaveLength(2);

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 2 });

    expect(await names('dst')).toEqual([
      'IMG (conflict from move).xmp',
      'IMG (replaced).CR3',
      'IMG.CR3',
    ]);
    expect(await read('dst/IMG (conflict from move).xmp')).toBe('old edits');
    expect(await read('dst/IMG (replaced).CR3')).toBe('old');
  });

  test('a displaced photo whose visible name is taken goes to the next free one, never over it', async () => {
    await write('src/IMG.CR3', 'new');
    await write('dst/IMG.CR3', 'old');
    await crashRelocation('after-swap');
    await write('dst/IMG (replaced).CR3', 'someone else');

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 1 });

    expect(await names('dst')).toEqual(['IMG (replaced 2).CR3', 'IMG (replaced).CR3', 'IMG.CR3']);
    expect(await read('dst/IMG (replaced).CR3')).toBe('someone else');
    expect(await read('dst/IMG (replaced 2).CR3')).toBe('old');
  });

  test('a long file name keeps its extension through the short hidden form', async () => {
    const long = `${'a'.repeat(240)}.CR3`;
    await write(`src/${long}`, 'new');
    await write(`dst/${long}`, 'old');
    await crashRelocation('after-swap', long);
    const [hidden] = await tempNames('dst');
    expect(hidden).toMatch(/^\.tmp\..*\.keep\.CR3$/);

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 1 });

    expect(await read('dst/Recovered file (replaced).CR3')).toBe('old');
    expect(await read(`dst/${long}`)).toBe('new');
    expect(await tempNames('dst')).toEqual([]);
  });

  test('a displaced photo whose only other name is a verifying copy is surfaced, not left for the copy cleanup to lose', async () => {
    await write('dst/IMG.CR3', 'new');
    const keep = deadPid(path.basename(privateSiblingOf(abs('dst/IMG.CR3'), DISPLACED_MARKER)));
    const copy = deadPid(
      path.basename(privateSiblingOf(abs('dst/OTHER.CR3'), VERIFYING_COPY_MARKER)),
    );
    await write(`dst/${keep}`, 'old');
    await fs.link(abs(`dst/${keep}`), abs(`dst/${copy}`));
    // The displaced name first, so the verifying copy still exists when it is judged.
    const entries = (await fs.readdir(abs('dst'), { withFileTypes: true })).toSorted(
      (a, b) => Number(b.name === keep) - Number(a.name === keep),
    );
    setSystemTime(new Date(Date.now() + 2 * DAY_MS));
    const outcome = await sweepCrashLeftTemps(abs('dst'), entries).finally(() => setSystemTime());

    expect(outcome).toEqual({ removed: 1, surfaced: 1 });
    expect(await names('dst')).toEqual(['IMG (replaced).CR3', 'IMG.CR3']);
    expect(await read('dst/IMG (replaced).CR3')).toBe('old');
  });
});

const REPLACE_SCRIPT = `
import { spyOn } from 'bun:test';
import * as fs from ${JSON.stringify(path.join(import.meta.dir, 'mirrored.ts'))};
import { replaceIfHolds } from ${JSON.stringify(path.join(import.meta.dir, 'sidecar-ownership.ts'))};
const [, , dest, tmp] = process.argv;
spyOn(fs, 'link').mockImplementation(async () => process.kill(process.pid, 'SIGKILL'));
await replaceIfHolds(dest, Buffer.from('old edits'), tmp, async () => {});
`;

describe('a sidecar replacement killed while the old sidecar is moved aside', () => {
  // Each displaced sidecar name, the photo whose edits it holds, and the name
  // they come back under: a dotted stem, a video's `<name>.<ext>.xmp`, a
  // conflict copy and a UUID variant all pair back to their photo.
  const uuid = '0123abcd-4567-89ab-cdef-0123456789ab';
  for (const [sidecar, photo, recovered] of [
    ['IMG.xmp', 'IMG.CR3', 'IMG (conflict from move).xmp'],
    ['IMG.001.xmp', 'IMG.001.CR3', 'IMG.001 (conflict from move).xmp'],
    ['clip.mov.xmp', 'clip.mov', 'clip.mov (conflict from move).xmp'],
    ['IMG (conflict from laptop).xmp', 'IMG.CR3', 'IMG (conflict from move).xmp'],
    ['IMG.001 (conflict from laptop) (2).xmp', 'IMG.001.CR3', 'IMG.001 (conflict from move).xmp'],
    [`IMG.001.v${uuid}.xmp`, 'IMG.001.CR3', 'IMG.001 (conflict from move).xmp'],
  ]) {
    test(`the old edits of ${sidecar} come back as ${recovered}, paired with ${photo}`, async () => {
      await write(`dst/${sidecar}`, 'old edits');
      await write('dst/staged', 'new edits');
      const script = abs('crash-replace.ts');
      await fs.writeFile(script, REPLACE_SCRIPT);
      const child = Bun.spawn(
        [process.execPath, script, abs(`dst/${sidecar}`), abs('dst/staged')],
        {
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
      await child.exited;
      expect(child.signalCode, await new Response(child.stderr).text()).toBe('SIGKILL');
      expect(await names('dst')).toEqual([
        expect.stringMatching(/\.xmp\.tmp\..*\.keep$/),
        'staged',
      ]);

      expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 1 });

      expect(await names('dst')).toEqual([recovered, 'staged']);
      expect(await read(`dst/${recovered}`)).toBe('old edits');
      expect(await listPairedSidecars(abs(`dst/${photo}`))).toEqual([abs(`dst/${recovered}`)]);
    });
  }
});

describe('what the sweep never touches', () => {
  test('a temp that has not been idle for a day', async () => {
    await write('dst/IMG.CR3', 'pixels');
    for (const marker of [VERIFYING_COPY_MARKER, DISPLACED_MARKER]) {
      await write(`dst/${path.basename(privateSiblingOf(abs('dst/IMG.CR3'), marker))}`, 'x');
    }

    expect(await sweep('dst', DAY_MS / 2)).toEqual({ removed: 0, surfaced: 0 });
    expect(await tempNames('dst')).toHaveLength(2);
  });

  test('a temp this process owns', async () => {
    const own = path.basename(privateSiblingOf(abs('dst/IMG.CR3'), DISPLACED_MARKER));
    await write(`dst/${own}`, 'in flight');

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 0 });
    expect(await names('dst')).toEqual([own]);
  });

  test('an unmarked temp that is not a second name for the file beside it', async () => {
    await write('dst/IMG.CR3', 'new');
    await write('dst/IMG.CR3.tmp.99999999-0123456789abcdef', 'the only copy');
    await write('dst/IMG.xmp.tmp.99999999-0123456789abcdef', 'an aside, with its base gone');

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 0 });
    expect(await tempNames('dst')).toHaveLength(2);
  });

  test('a file that only looks like a temp', async () => {
    const lookalikes = [
      'IMG.tmp.JPG',
      'IMG.tmp.123.JPG',
      'IMG.JPG.tmp.99999999-xyz.copy',
      'IMG.JPG.tmp.99999999-xyz.keep',
      'IMG.JPG.tmp.99999999.0123456789abcdef.copy',
      'IMG.JPG.tmp.99999999.0123456789abcdef.keep',
      'IMG.JPG.tmp.copy',
      'IMG.JPG.tmp.keep',
    ];
    for (const name of lookalikes) await write(`dst/${name}`, 'photo');

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 0 });
    expect(await names('dst')).toEqual(lookalikes.toSorted());
  });

  test('a marked temp that is a directory', async () => {
    for (const marker of [VERIFYING_COPY_MARKER, DISPLACED_MARKER]) {
      const dir = `dst/IMG.CR3.tmp.99999999-0123456789abcdef${marker}`;
      await fs.mkdir(abs(dir), { recursive: true });
      await write(`${dir}/inside.txt`, 'x');
    }

    expect(await sweep('dst')).toEqual({ removed: 0, surfaced: 0 });
    expect(await read('dst/IMG.CR3.tmp.99999999-0123456789abcdef.keep/inside.txt')).toBe('x');
  });
});

describe('a private name of a long file name', () => {
  const long = `${'a'.repeat(240)}.CR3`;
  const hiddenName = (marker?: string) =>
    deadPid(path.basename(privateSiblingOf(abs(`dst/${long}`), marker)));

  test('a verifying copy is the short hidden form and is removed once abandoned', async () => {
    expect(hiddenName(VERIFYING_COPY_MARKER).startsWith('.tmp.')).toBe(true);
    await write(`dst/${hiddenName(VERIFYING_COPY_MARKER)}`, 'partial');

    expect(await sweep('dst')).toEqual({ removed: 1, surfaced: 0 });
    expect(await names('dst')).toEqual([]);
  });

  test('an extension that reads as a marker is not kept, so an unmarked name is never taken for a marked one', () => {
    for (const extension of ['.copy', '.keep']) {
      const hidden = path.basename(privateSiblingOf(abs(`dst/${'a'.repeat(250)}${extension}`)));
      expect(hidden.startsWith('.tmp.')).toBe(true);
      expect(parsePrivateSibling(deadPid(hidden))?.kind).toBe('unmarked');
    }
  });
});
