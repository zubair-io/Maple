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
 * Platform-specific napi addon filename: `raw-napi.<platform>-<arch>[-<abi>].node`.
 * CONFIRMED (#3509 Task 9): this is the exact filename
 * `.github/workflows/publish-package.yml`'s `build-linux`/`build-macos`/
 * `build-windows` jobs produce (plain `cargo build`/`cargo zigbuild` on the
 * cargo-native `.so`/`.dylib`/`.dll`, renamed to this convention by hand —
 * there is no `@napi-rs/cli` in this repo's toolchain), and what
 * `assemble-packages.ts` copies into each `npm/<platform>/` package under
 * this same name. Keep this function and those two build/assemble sites in
 * sync on any future rename.
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
