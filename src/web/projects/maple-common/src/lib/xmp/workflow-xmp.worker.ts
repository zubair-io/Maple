/// <reference lib="webworker" />
import init, { workflow_read_xmp, workflow_embed_xmp } from '../raw-pipeline/pkg/raw_wasm';
// Metadata needs neither pixel buffers nor Rayon. Never used for render ticks.
const ready = init({ module_or_path: '/raw_wasm_bg.wasm' });
addEventListener(
  'message',
  async (
    event: MessageEvent<{
      id: number;
      xmp: string;
      json?: string;
    }>,
  ) => {
    try {
      await ready;
      const value =
        event.data.json === undefined
          ? workflow_read_xmp(event.data.xmp)
          : workflow_embed_xmp(event.data.json, event.data.xmp);
      postMessage({ id: event.data.id, value });
    } catch (error) {
      postMessage({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
