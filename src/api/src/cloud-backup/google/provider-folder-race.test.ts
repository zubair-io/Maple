import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
import { googleStore } from './google-store.test-helpers.ts';

test('concurrent provider instances reuse folders created for the same Drive path', async () => {
  const root = 'maple-root';
  const store = googleStore();
  const providers = [
    new GoogleDriveProvider(root, async () => 'token', store.transport),
    new GoogleDriveProvider(root, async () => 'token', store.transport),
  ];
  const library = 'a'.repeat(24);
  await Promise.all(
    providers.map((provider, index) => {
      const bytes = new Uint8Array([index + 1]);
      return provider.mirrorFile(
        `mirror/${library}/2024/Wedding/${index}.JPG`,
        `2024/Wedding/${index}.JPG`,
        {
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          open: (offset) =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(offset));
                controller.close();
              },
            }),
        },
        { saveCheckpoint: async () => {} },
      );
    }),
  );

  const paths = [...store.files.values()]
    .filter((file) => file.mimeType === 'application/vnd.google-apps.folder')
    .map((file) => JSON.parse(file.description) as { rootId: string; path: string })
    .filter((marker) => marker.rootId === root)
    .map((marker) => marker.path);
  expect(paths.filter((path) => path === '2024')).toHaveLength(1);
  expect(paths.filter((path) => path === '2024/Wedding')).toHaveLength(1);
});
