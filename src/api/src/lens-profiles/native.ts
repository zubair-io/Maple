/** Loaded only in an isolated FFI child, never the HTTP process. */
import { CString, dlopen, FFIType, ptr, type Pointer } from 'bun:ffi';
import { nativeLibPath } from '../ffi/raw_ffi.ts';
import type { LensProfileInventory } from './types.ts';

function openLensLibrary() {
  return dlopen(nativeLibPath(), {
    maple_lens_profile_register: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_lens_profile_selected: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_lens_profile_clear_cache: { args: [], returns: FFIType.i32 },
    maple_lens_profile_resolve_file: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_free_lens_profile_json: { args: [FFIType.ptr], returns: FFIType.void },
    maple_last_error: { args: [], returns: FFIType.cstring },
  });
}

let library: ReturnType<typeof openLensLibrary> | undefined;
function symbols() {
  return (library ??= openLensLibrary()).symbols;
}

function jsonResult<T>(invoke: (output: Buffer) => number): T {
  const output = Buffer.alloc(8);
  const rc = invoke(output);
  const address = Number(output.readBigUInt64LE()) as Pointer;
  try {
    if (rc !== 0) throw new Error(`LCP operation failed (${rc}): ${symbols().maple_last_error()}`);
    if (!address) throw new Error('LCP engine returned no result');
    return JSON.parse(new CString(address).toString()) as T;
  } finally {
    if (address) symbols().maple_free_lens_profile_json(address);
  }
}

export function registerLensProfile(bytes: Uint8Array): LensProfileInventory {
  return jsonResult((output) =>
    symbols().maple_lens_profile_register(ptr(bytes), bytes.length, ptr(output)),
  );
}

export function selectedLensProfile(xml: string): { reference: string; enabled: boolean } {
  const bytes = Buffer.from(xml);
  return jsonResult((output) =>
    symbols().maple_lens_profile_selected(ptr(bytes), bytes.length, ptr(output)),
  );
}

export function clearLensProfiles(): void {
  if (symbols().maple_lens_profile_clear_cache() !== 0) throw new Error('LCP cache reset failed');
}

export function resolveLensProfile(rawPath: string, reference: string): { source: string } {
  const path = Buffer.from(rawPath + '\0');
  const ref = Buffer.from(reference + '\0');
  return jsonResult((output) =>
    symbols().maple_lens_profile_resolve_file(ptr(path), ptr(ref), ptr(output)),
  );
}
