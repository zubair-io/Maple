import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import fs, * as mirrored from '../fs/mirrored.ts';
import { PublishCollisionError } from '../fs/relocate-publish.ts';
import { publishWhole } from './pano-publish.ts';

let dir = '';
let source = '';
let destination = '';
const bytes = Buffer.from('a whole panorama');

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-publish-')));
  source = path.join(dir, 'stitched.png');
  destination = path.join(dir, 'Panoramas-pano.png');
  await fs.writeFile(source, bytes);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entries = async () => (await fs.readdir(dir)).sort();

test('publishes the whole file and leaves no staging file behind', async () => {
  await publishWhole(source, destination);
  expect(await fs.readFile(destination)).toEqual(bytes);
  expect(await entries()).toEqual(['Panoramas-pano.png', 'stitched.png']);
});

test('never replaces a file already at the name', async () => {
  await fs.writeFile(destination, 'earlier');
  await expect(publishWhole(source, destination)).rejects.toBeInstanceOf(PublishCollisionError);
  expect(await fs.readFile(destination, 'utf8')).toBe('earlier');
  expect(await entries()).toEqual(['Panoramas-pano.png', 'stitched.png']);
});

test('a copy that dies part-way never appears at the final name', async () => {
  const copy = spyOn(mirrored, 'copyFile').mockImplementationOnce(async (_src, staged) => {
    await fs.writeFile(String(staged), 'trunc');
    throw new Error('disk vanished');
  });
  try {
    await expect(publishWhole(source, destination)).rejects.toThrow('disk vanished');
  } finally {
    copy.mockRestore();
  }
  expect(await entries()).toEqual(['stitched.png']);
});

test('renames into a free name on a volume that cannot hard-link', async () => {
  const noLink = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  const link = spyOn(mirrored, 'link').mockRejectedValueOnce(noLink);
  try {
    await publishWhole(source, destination);
  } finally {
    link.mockRestore();
  }
  expect(await fs.readFile(destination)).toEqual(bytes);
  expect(await entries()).toEqual(['Panoramas-pano.png', 'stitched.png']);
});

test('refuses a taken name on a volume that cannot hard-link', async () => {
  await fs.symlink(path.join(dir, 'elsewhere'), destination);
  const noLink = Object.assign(new Error('not supported'), { code: 'EPERM' });
  const link = spyOn(mirrored, 'link').mockRejectedValueOnce(noLink);
  try {
    await expect(publishWhole(source, destination)).rejects.toBeInstanceOf(PublishCollisionError);
  } finally {
    link.mockRestore();
  }
  expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
});

test('passes on a link failure that is not about link support', async () => {
  const denied = Object.assign(new Error('read-only'), { code: 'EROFS' });
  const link = spyOn(mirrored, 'link').mockRejectedValueOnce(denied);
  try {
    await expect(publishWhole(source, destination)).rejects.toThrow('read-only');
  } finally {
    link.mockRestore();
  }
  expect(await entries()).toEqual(['stitched.png']);
});

test('refuses bytes that do not match what was stitched', async () => {
  const copy = spyOn(mirrored, 'copyFile').mockImplementationOnce(async (_src, staged) => {
    await fs.writeFile(String(staged), 'different');
  });
  try {
    await expect(publishWhole(source, destination)).rejects.toThrow('verification failed');
  } finally {
    copy.mockRestore();
  }
  expect(await entries()).toEqual(['stitched.png']);
});
