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
 * Resolves the native shared library from an installed platform package in node_modules.
 */
export declare function resolvePlatformPackageLib(): string | null;
