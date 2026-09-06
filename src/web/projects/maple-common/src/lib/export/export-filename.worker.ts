/// <reference lib="webworker" />
import init, { render_filename_template } from '../raw-pipeline/pkg/raw_wasm';
// Naming needs no render buffers or Rayon pool. Keep this small instance off the UI thread.
const ready = init({ module_or_path: '/raw_wasm_bg.wasm' });
addEventListener(
  'message',
  async (
    event: MessageEvent<{
      id: number;
      template: string;
      filename: string;
      ext: string;
      capturedAt: string | null;
      index: number;
    }>,
  ) => {
    try {
      await ready;
      const { template, filename, ext, capturedAt, index } = event.data;
      const last = filename.replaceAll('\\', '/').split('/').at(-1)!;
      const dot = last.lastIndexOf('.');
      const stem = dot > 0 ? last.slice(0, dot) : last;
      const name = render_filename_template(template, stem, ext, capturedAt, 1n, BigInt(index), 0);
      if (!name.endsWith(`.${ext}`))
        throw new Error('Naming template must end with the selected {ext}');
      postMessage({ id: event.data.id, name });
    } catch (error) {
      postMessage({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
