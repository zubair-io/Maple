/**
 * `discover` worker config — the sweeper's two operator-tunable knobs, stored
 * in the shared `worker_config` row keyed by `name = 'discover'` (the same
 * table the stages and the missing-reaper use). Tunable on /settings/workers,
 * NOT an env var (repo convention).
 *
 * The bodies moved to `db/sqlite/repos/worker-config.repo.ts` at the cutover
 * (#3787), which is where they belong: the discover row and a stage row are
 * rows of one table differing only in which columns they fill in, so putting
 * two modules' statements on that table was the thing worth avoiding. This
 * module stays as the import path `index.ts` and `register.ts` already use.
 *
 * Each name is re-exported explicitly rather than with `export *`, so a name
 * whose shape changed fails to compile here instead of being swapped silently.
 */
export {
  loadDiscoverConfig,
  patchDiscoverConfig,
} from '../../db/sqlite/repos/worker-config.repo.ts';
export type { DiscoverConfig } from '../../db/sqlite/repos/worker-config.repo.ts';
