/**
 * Platform detection and native package resolution for @justmaple/maple.
 */
/**
 * Detect whether the current Linux environment uses musl libc (e.g. Alpine Linux).
 */
export declare function isMusl(): boolean;
/**
 * Returns the expected platform binary package name for the current runtime, or null if unsupported.
 */
export declare function getPlatformPackageName(platform?: NodeJS.Platform, arch?: NodeJS.Architecture, musl?: boolean): string | null;
/**
 * Platform-specific dynamic library file name.
 */
export declare function getPlatformBinaryFilename(platform?: NodeJS.Platform): string;
/**
 * Platform-specific napi addon filename, GUESSING at napi-rs's own
 * per-platform naming convention (`<crate>.<platform>-<arch>[-<abi>].node`)
 * for when a published `@justmaple/maple-<platform>` package carries a
 * prebuilt addon. PROVISIONAL: this has not been verified against a real
 * `@napi-rs/cli` `napi build` invocation or any real CI-produced artifact —
 * Task 9 owns the real per-platform build+rename step and MUST verify (or
 * correct) this string against that actual output before anything depends
 * on it in production; this just needs to agree with that naming once it
 * exists — see `resolvePlatformNapiAddon`'s local-dev fallback below for how
 * this package resolves an addon before that exists.
 */
export declare function getPlatformNapiFilename(platform?: NodeJS.Platform, arch?: NodeJS.Architecture, musl?: boolean): string;
/**
 * Resolves the napi addon the same way `resolvePlatformPackageLib` resolves
 * the bun:ffi dylib — installed platform package first, then monorepo-local
 * dev paths. Returns null (never throws) when nothing matches, so the
 * caller (`native-napi.ts`) can fall back to bun:ffi.
 *
 * The monorepo-dev candidates point straight at `raw-napi`'s own cargo
 * target dir, at the plain `.dylib`/`.so` cargo produces — NOT renamed to
 * `.node`. That is deliberate: `native-napi.ts` loads whatever path this
 * returns via `process.dlopen` rather than `require`, which works
 * regardless of the file's extension (verified empirically — a bare
 * `require()` on a `.dylib`-suffixed path throws `Invalid or unexpected
 * token` on both Node and Bun, since each module loader picks a handler by
 * extension and neither registers one for `.dylib`/`.so`; `process.dlopen`
 * is the same primitive their own built-in `.node` loader calls internally,
 * and Node's own docs recommend it directly over `require()` for loading a
 * native addon from an ES module — see `native-napi.ts`'s loader).
 */
export declare function resolvePlatformNapiAddon(): string | null;
/**
 * Resolves the native shared library from an installed platform package in node_modules.
 */
export declare function resolvePlatformPackageLib(): string | null;
