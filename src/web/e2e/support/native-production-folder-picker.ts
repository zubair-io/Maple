import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';

const CHUNK_BYTES = 4 * 1024 * 1024;

/** Real, structured-cloneable browser handles for the batch worker. Only the
 * native picker boundary is replaced; sidecars live in disposable browser OPFS. */
export async function installNativeProductionFolderPicker(page: Page, root: string) {
  const folderName = basename(root);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Native batch fixtures must be reset before staging root files');
  }
  const files = await Promise.all(
    entries.map(async ({ name }) => {
      const path = join(root, name);
      const metadata = await stat(path);
      const sha256 = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      return { name, size: metadata.size, sha256 };
    }),
  );
  await page.exposeBinding(
    '__mapleNativeFixtureChunk',
    async (_source, name: string, offset: number) => {
      const file = files.find((entry) => entry.name === name);
      if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) {
        throw new Error('Invalid native fixture chunk');
      }
      const handle = await open(join(root, name), 'r');
      try {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, file.size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) throw new Error(`Fixture was truncated: ${name}`);
        return chunk.subarray(0, bytesRead).toString('base64');
      } finally {
        await handle.close();
      }
    },
  );
  await page.addInitScript(
    ({ folderName, files }) => {
      const bindings = window as typeof window & {
        __mapleNativeFixtureChunk(name: string, offset: number): Promise<string>;
      };
      let staged: Promise<FileSystemDirectoryHandle> | undefined;
      async function stage() {
        const storage = await navigator.storage.getDirectory();
        const directory = await storage.getDirectoryHandle(folderName, { create: true });
        for (const file of files) {
          const handle = await directory.getFileHandle(file.name, { create: true });
          const writer = await handle.createWritable();
          try {
            let offset = 0;
            while (offset < file.size) {
              const binary = atob(await bindings.__mapleNativeFixtureChunk(file.name, offset));
              const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
              await writer.write(bytes);
              offset += bytes.length;
            }
            await writer.close();
          } catch (error) {
            await writer.abort();
            throw error;
          }
          const digest = await crypto.subtle.digest(
            'SHA-256',
            await (await handle.getFile()).arrayBuffer(),
          );
          const sha256 = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
          if (sha256 !== file.sha256)
            throw new Error(`Native fixture checksum mismatch: ${file.name}`);
        }
        return directory;
      }
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: () => (staged ??= stage()),
      });
    },
    { folderName, files },
  );
  return {
    readText: (name: string) =>
      page.evaluate(
        async ({ folderName, name }) => {
          const directory = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(folderName);
          return (await (await directory.getFileHandle(name)).getFile()).text();
        },
        { folderName, name },
      ),
    writeText: (name: string, text: string) =>
      page.evaluate(
        async ({ folderName, name, text }) => {
          const directory = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(folderName);
          const writer = await (await directory.getFileHandle(name)).createWritable();
          await writer.write(text);
          await writer.close();
        },
        { folderName, name, text },
      ),
    verifyRawHashes: async () => {
      const hashes = await page.evaluate(
        async ({ folderName, files }) => {
          const directory = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(folderName);
          return Promise.all(
            files
              .filter(({ name }) => !name.toLowerCase().endsWith('.xmp'))
              .map(async ({ name }) => {
                const file = await (await directory.getFileHandle(name)).getFile();
                const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
                return {
                  name,
                  sha256: [...new Uint8Array(digest)]
                    .map((byte) => byte.toString(16).padStart(2, '0'))
                    .join(''),
                };
              }),
          );
        },
        { folderName, files },
      );
      for (const file of hashes) {
        if (files.find(({ name }) => name === file.name)?.sha256 !== file.sha256) {
          throw new Error(`Browser original was modified: ${file.name}`);
        }
      }
    },
  };
}
