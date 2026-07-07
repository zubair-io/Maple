/**
 * `bun test` preload (see bunfig.toml's `[test] preload`). Runs once before
 * any test file, in the same process every test file's hooks share.
 *
 * Flips `src/db/client.ts`'s shared MongoDB singleton into "detach, don't
 * force-close" mode for the lifetime of this `bun test` process — see the
 * comment on `_setTestDetachOnly` / `closeDb()` in that file for the full
 * race this avoids. Production shutdown (`src/index.ts`) never imports this
 * file, so it always keeps the real force-close behavior.
 */
import { _setTestDetachOnly } from './src/db/client.ts';

_setTestDetachOnly(true);
