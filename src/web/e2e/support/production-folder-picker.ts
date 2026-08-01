import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';

interface DirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

export interface FolderPickerOperation {
  readonly kind: 'read' | 'write';
  readonly path: string;
  readonly at: number;
}

export interface ProductionFolderPickerAudit {
  readonly operations: FolderPickerOperation[];
  clear(): void;
  setWritePermission(granted: boolean): void;
}

function fixturePath(root: string, requested: string): string {
  const path = resolve(root, requested);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) === resolve(root)) {
    if (requested === '') return root;
    throw new Error(`Production folder picker escaped its fixture root: ${requested}`);
  }
  return path;
}

/**
 * Route the production build's File System Access calls to a disposable real
 * directory. Playwright cannot drive Chrome's native `showDirectoryPicker`
 * dialog, so the shim stops at that browser boundary; Maple's folder, cache,
 * and XMP services remain the production implementations under test.
 */
export async function installProductionFolderPicker(
  page: Page,
  root: string,
): Promise<ProductionFolderPickerAudit> {
  const operations: FolderPickerOperation[] = [];
  let writePermission: PermissionState = 'granted';
  await page.exposeBinding('__mapleE2eListDirectory', async (_source, requested: string) => {
    const entries = await readdir(fixturePath(root, requested), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map<DirectoryEntry>((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
      }));
  });
  await page.exposeBinding('__mapleE2eReadFile', async (_source, requested: string) => {
    operations.push({ kind: 'read', path: requested, at: Date.now() });
    return (await readFile(fixturePath(root, requested))).toString('base64');
  });
  await page.exposeBinding('__mapleE2eFileMetadata', async (_source, requested: string) => {
    const metadata = await stat(fixturePath(root, requested));
    return { size: metadata.size, lastModified: metadata.mtimeMs };
  });
  await page.exposeBinding(
    '__mapleE2eWriteFile',
    async (_source, requested: string, base64: string) => {
      if (writePermission !== 'granted') {
        throw new DOMException('Write permission was revoked', 'NotAllowedError');
      }
      operations.push({ kind: 'write', path: requested, at: Date.now() });
      const path = fixturePath(root, requested);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(base64, 'base64'));
    },
  );
  await page.exposeBinding('__mapleE2eEnsureDirectory', async (_source, requested: string) => {
    if (writePermission !== 'granted') {
      throw new DOMException('Write permission was revoked', 'NotAllowedError');
    }
    await mkdir(fixturePath(root, requested), { recursive: true });
  });
  await page.exposeBinding('__mapleE2eWritePermission', async () => writePermission);

  await page.addInitScript(
    ({ folderName }) => {
      const bindings = window as typeof window & {
        __mapleE2eListDirectory(path: string): Promise<DirectoryEntry[]>;
        __mapleE2eReadFile(path: string): Promise<string>;
        __mapleE2eFileMetadata(path: string): Promise<{ size: number; lastModified: number }>;
        __mapleE2eWriteFile(path: string, base64: string): Promise<void>;
        __mapleE2eEnsureDirectory(path: string): Promise<void>;
        __mapleE2eWritePermission(): Promise<PermissionState>;
      };

      const joinPath = (parent: string, child: string) =>
        parent.length > 0 ? `${parent}/${child}` : child;
      const bytesToBase64 = (bytes: Uint8Array) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        }
        return btoa(binary);
      };
      const base64ToBytes = (base64: string) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return bytes;
      };

      const fileHandle = (path: string, name: string) => ({
        kind: 'file' as const,
        name,
        async getFile() {
          const metadata = await bindings.__mapleE2eFileMetadata(path);
          // File System Access exposes size/mtime without consuming the file's
          // bytes. Keep this test double lazy too: source-identity validation
          // must not turn a warm preview lookup into a full RAW transfer.
          return {
            name,
            type: '',
            size: metadata.size,
            lastModified: metadata.lastModified,
            async arrayBuffer() {
              const bytes = base64ToBytes(await bindings.__mapleE2eReadFile(path));
              return bytes.buffer;
            },
          } as File;
        },
        async createWritable() {
          let value = new Uint8Array();
          return {
            async write(data: Blob | BufferSource | string) {
              if (typeof data === 'string') value = new TextEncoder().encode(data);
              else if (data instanceof Blob) value = new Uint8Array(await data.arrayBuffer());
              else if (ArrayBuffer.isView(data)) {
                value = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
              } else value = new Uint8Array(data.slice(0));
            },
            async close() {
              await bindings.__mapleE2eWriteFile(path, bytesToBase64(value));
            },
          };
        },
      });

      const directoryHandle = (path: string, name: string) => ({
        kind: 'directory' as const,
        name,
        async queryPermission() {
          return bindings.__mapleE2eWritePermission();
        },
        async requestPermission() {
          return bindings.__mapleE2eWritePermission();
        },
        async *entries() {
          for (const entry of await bindings.__mapleE2eListDirectory(path)) {
            const childPath = joinPath(path, entry.name);
            yield [
              entry.name,
              entry.kind === 'directory'
                ? directoryHandle(childPath, entry.name)
                : fileHandle(childPath, entry.name),
            ];
          }
        },
        async getDirectoryHandle(child: string, options?: { create?: boolean }) {
          const childPath = joinPath(path, child);
          if (options?.create) await bindings.__mapleE2eEnsureDirectory(childPath);
          return directoryHandle(childPath, child);
        },
        async getFileHandle(child: string) {
          return fileHandle(joinPath(path, child), child);
        },
      });

      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => directoryHandle('', folderName),
      });
    },
    { folderName: root.split('/').filter(Boolean).pop() ?? 'folder' },
  );

  return {
    operations,
    clear: () => operations.splice(0),
    setWritePermission: (granted) => {
      writePermission = granted ? 'granted' : 'denied';
    },
  };
}
