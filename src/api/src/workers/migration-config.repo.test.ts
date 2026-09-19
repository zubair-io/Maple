/**
 * Migration registry state, against a per-test SQLite database.
 *
 * Covers the one operation in this module with no equivalent anywhere else in
 * the settings layer: pruning the state of migrations that no longer exist.
 * Migration ids are kebab-case, so the dotted paths this drives through
 * `patchAppSettings` / `unsetAppSettings` are exactly the case that needs each
 * path segment quoted on the way into SQLite's JSON path syntax.
 */

import { describe, expect, it } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  defaultMigrationState,
  loadAllMigrationStates,
  loadMigrationState,
  patchMigrationState,
  pruneUnknownMigrationStates,
} from './migration-config.repo.ts';

describe('migration-config.repo', () => {
  it('defaults every field when nothing has been written', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadAllMigrationStates()).toEqual({});
    expect(await loadMigrationState('refile-backups')).toEqual(defaultMigrationState());
  });

  it('patches one field of a kebab-case migration without disturbing its siblings', async () => {
    using _live = await createLiveTestDatabase();
    await patchMigrationState('refile-backups', { enabled: true, processed: 7 });
    await patchMigrationState('dedupe-locations', { enabled: false });
    await patchMigrationState('refile-backups', { processed: 9 });

    const state = await loadMigrationState('refile-backups');
    expect(state.enabled).toBe(true);
    expect(state.processed).toBe(9);
    expect(Object.keys(await loadAllMigrationStates()).sort()).toEqual([
      'dedupe-locations',
      'refile-backups',
    ]);
  });

  it('prunes ids missing from the registry and leaves the known ones alone', async () => {
    using _live = await createLiveTestDatabase();
    await patchMigrationState('refile-backups', { enabled: true });
    await patchMigrationState('retired-migration', { enabled: true });

    expect(await pruneUnknownMigrationStates(['refile-backups'])).toEqual(['retired-migration']);

    const all = await loadAllMigrationStates();
    expect(Object.keys(all)).toEqual(['refile-backups']);
    expect(all['refile-backups']?.enabled).toBe(true);
  });

  it('prunes nothing when every stored id is still registered', async () => {
    using _live = await createLiveTestDatabase();
    await patchMigrationState('refile-backups', { enabled: true });
    expect(await pruneUnknownMigrationStates(['refile-backups', 'never-written'])).toEqual([]);
    expect(Object.keys(await loadAllMigrationStates())).toEqual(['refile-backups']);
  });
});
