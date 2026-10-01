// Execute the same actual WASM cold owner outside Playwright's CJS transform.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
export async function savedPng(root: string, output: string): Promise<Uint8Array> {
  await run(process.execPath, [resolve(__dirname, 'saved-export-oracle.mjs'), root, output]);
  return new Uint8Array(await readFile(output));
}
