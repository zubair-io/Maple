/** Find the platform-specific library name */
export declare function nativeLibFilename(): string;
/**
 * Locate the native shared library.
 *
 * Order: the explicit `MAPLE_NATIVE_LIB` override, then a binary built from
 * this checkout, then the installed `@justmaple/maple-<platform>` package,
 * then generic runtime locations. The source-built paths point at sibling
 * crates/packages that only exist inside the monorepo (an installed npm
 * package never has them), so they are an explicit "use what `cargo build`
 * just produced" selection, not a search of arbitrary local files — a local
 * pipeline change is what `bun test` and the API exercise, never a stale
 * prebuilt pulled in by `bun install`.
 */
export declare function findNativeLib(): string | null;
