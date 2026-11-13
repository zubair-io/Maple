import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';

let oldRoots: string | undefined;
let root: string;
let nested: string;
let aliasRoot: string | undefined;
let enclosingAliasRoot: string | undefined;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-path-auth-')));
  nested = join(root, 'nested');
  await mkdir(nested);
  process.env.MAPLE_ROOTS = '';
  setLibraryRootsForTests(
    new Map([
      ['outer', root],
      ['inner', nested],
    ]),
  );
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  setLibraryRootsForTests(null);
  if (aliasRoot) await rm(aliasRoot, { force: true });
  if (enclosingAliasRoot) await rm(enclosingAliasRoot, { force: true });
  await rm(root, { recursive: true, force: true });
  aliasRoot = undefined;
  enclosingAliasRoot = undefined;
});

test('nested registered paths scope admission to their canonical destination folder', async () => {
  const filePath = join(nested, 'photo.dng');
  const result = await resolveAndAuthorizePath(filePath);

  expect(result).toEqual({
    ok: true,
    data: filePath,
    writeScope: nested,
  });
});

test('enclosing MAPLE_ROOTS paths share admission with nested registered libraries', async () => {
  const enclosingRoot = dirname(root);
  process.env.MAPLE_ROOTS = enclosingRoot;
  const filePath = join(nested, 'photo.dng');
  const result = await resolveAndAuthorizePath(filePath);

  expect(result).toEqual({
    ok: true,
    data: filePath,
    writeScope: nested,
  });
});

test('symlink-equivalent library roots share a canonical write admission scope', async () => {
  aliasRoot = join(dirname(root), `${basename(root)}-alias`);
  await symlink(root, aliasRoot, 'dir');
  process.env.MAPLE_ROOTS = aliasRoot;

  const direct = await resolveAndAuthorizePath(join(root, 'photo.dng'));
  const aliased = await resolveAndAuthorizePath(join(aliasRoot, 'photo.dng'));

  expect(direct).toEqual({
    ok: true,
    data: join(root, 'photo.dng'),
    writeScope: root,
  });
  expect(aliased).toEqual({
    ok: true,
    data: join(aliasRoot, 'photo.dng'),
    writeScope: root,
  });
});

test('a nested alias shares its canonical destination folder scope with its direct path', async () => {
  aliasRoot = join(dirname(root), `${basename(root)}-nested-alias`);
  await symlink(nested, aliasRoot, 'dir');
  process.env.MAPLE_ROOTS = root;
  setLibraryRootsForTests(new Map([['nested-alias', aliasRoot]]));

  const direct = await resolveAndAuthorizePath(join(nested, 'photo.dng'));
  const aliased = await resolveAndAuthorizePath(join(aliasRoot, 'photo.dng'));

  expect(direct).toEqual({
    ok: true,
    data: join(nested, 'photo.dng'),
    writeScope: nested,
  });
  expect(aliased).toEqual({
    ok: true,
    data: join(aliasRoot, 'photo.dng'),
    writeScope: nested,
  });
});

test('nested and enclosing symlink roots share admission for one destination folder', async () => {
  const innerAlias = join(dirname(root), `${basename(root)}-inner-alias`);
  const outerAlias = join(dirname(root), `${basename(root)}-outer-alias`);
  aliasRoot = innerAlias;
  enclosingAliasRoot = outerAlias;
  await symlink(nested, innerAlias, 'dir');
  await symlink(root, outerAlias, 'dir');
  setLibraryRootsForTests(
    new Map([
      ['inner-alias', innerAlias],
      ['outer-alias', outerAlias],
    ]),
  );

  const throughInner = await resolveAndAuthorizePath(join(innerAlias, 'photo.dng'));
  const throughOuter = await resolveAndAuthorizePath(join(outerAlias, 'nested', 'photo.dng'));

  expect(throughInner.ok).toBe(true);
  expect(throughOuter.ok).toBe(true);
  if (!throughInner.ok || !throughOuter.ok) throw new Error('registered alias roots were rejected');
  expect(throughInner.writeScope).toBe(nested);
  expect(throughOuter.writeScope).toBe(throughInner.writeScope);

  const firstDestination = join(innerAlias, 'photo.xmp');
  const secondDestination = join(outerAlias, 'nested', 'photo.xmp');
  const realRealpath = nodeFs.realpath.bind(nodeFs);
  const { promise: firstLookup, resolve: markFirstLookup } = Promise.withResolvers<void>();
  const { promise: releaseLookup, resolve: resumeLookup } = Promise.withResolvers<void>();
  const order: string[] = [];
  const realpathSpy = spyOn(nodeFs, 'realpath').mockImplementation((async (
    ...args: Parameters<typeof nodeFs.realpath>
  ) => {
    if (String(args[0]) === firstDestination) {
      markFirstLookup();
      await releaseLookup;
    }
    return realRealpath(...args);
  }) as never);

  try {
    const firstWrite = serializeSidecarWrite(
      firstDestination,
      async () => {
        order.push('inner-root');
      },
      { admissionScope: throughInner.writeScope },
    );
    await firstLookup;
    const secondWrite = serializeSidecarWrite(
      secondDestination,
      async () => {
        order.push('outer-root');
      },
      { admissionScope: throughOuter.writeScope },
    );
    await Bun.sleep(10);
    expect(order).toEqual([]);

    resumeLookup();
    await Promise.all([firstWrite, secondWrite]);
    expect(order).toEqual(['inner-root', 'outer-root']);
  } finally {
    resumeLookup();
    realpathSpy.mockRestore();
  }
});
