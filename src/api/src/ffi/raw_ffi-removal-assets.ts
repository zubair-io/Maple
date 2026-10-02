/** #1472: durable asset validation runs in the existing isolated FFI child. */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readFile } from '../fs/mirrored.ts';
import { dirname, join } from 'node:path';
import { nativeLibPath } from './raw_ffi.ts';

function open() {
  return dlopen(nativeLibPath(), {
    maple_removal_asset_names_buf: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_removal_asset_verify: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    maple_removal_content_digest: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    maple_removal_source_verify: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
    maple_last_error: { args: [], returns: FFIType.cstring },
  });
}

export interface VerifiedRemovalAssets {
  names: string[];
  originalDigest: string;
}

export async function verifyRemovalFileAssets(
  rawPath: string,
  records: string,
): Promise<VerifiedRemovalAssets> {
  const lib = open();
  const { symbols } = lib;
  const check = (rc: number, probe = false) => {
    if (rc !== 0 && !(probe && rc === 100))
      throw new Error(String(symbols.maple_last_error() ?? `Removal validation failed (${rc})`));
  };
  try {
    const wire = Buffer.from(records + '\0');
    const length = Buffer.alloc(8);
    check(symbols.maple_removal_asset_names_buf(ptr(wire), null, 0, ptr(length)), true);
    const size = Number(length.readBigUInt64LE());
    // Names cannot exceed their input record wire, and no unchecked native
    // size may allocate into the child. This is a transport bound, not a
    // second metadata schema or an operator configuration knob.
    if (!Number.isSafeInteger(size) || size < 0 || size > wire.length)
      throw new Error('Invalid removal asset-list length');
    const output = Buffer.alloc(size);
    check(symbols.maple_removal_asset_names_buf(ptr(wire), ptr(output), size, ptr(length)));
    const names = JSON.parse(output.toString()) as string[];
    const original = await readFile(rawPath);
    const digest = Buffer.alloc(256);
    check(
      symbols.maple_removal_content_digest(
        ptr(original),
        original.length,
        ptr(digest),
        digest.length,
      ),
    );
    const originalDigest = digest.toString('utf8', 0, digest.indexOf(0));
    const source = Buffer.from(originalDigest + '\0');
    check(symbols.maple_removal_source_verify(ptr(wire), ptr(source)));
    for (const name of names) {
      const bytes = await readFile(join(dirname(rawPath), '.maple/inpaint', name));
      const basename = Buffer.from(name + '\0');
      check(symbols.maple_removal_asset_verify(ptr(basename), ptr(bytes), bytes.length));
    }
    return { names, originalDigest };
  } finally {
    lib.close();
  }
}
