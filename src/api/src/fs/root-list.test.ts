import { expect, test } from 'bun:test';
import { delimiter, posix, win32 } from 'node:path';
import { parseRootList } from './root-list.ts';

test('Windows root lists preserve drive letters, spaces and UNC shares', () => {
  expect(parseRootList('C:\\Photos;D:\\Family Photos;\\\\nas\\photos;;', win32.delimiter)).toEqual([
    'C:\\Photos',
    'D:\\Family Photos',
    '\\\\nas\\photos',
  ]);
});

test('POSIX root lists preserve semicolons in directory names', () => {
  expect(parseRootList('/photos;/family:/archive::', posix.delimiter)).toEqual([
    '/photos;/family',
    '/archive',
  ]);
});

test('root lists default to the host delimiter and ignore empty entries', () => {
  expect(parseRootList(['first', '', 'second'].join(delimiter))).toEqual(['first', 'second']);
  expect(parseRootList(undefined)).toEqual([]);
  expect(parseRootList('')).toEqual([]);
});
