/// <reference lib="webworker" />
import init, {
  workflow_read_xmp,
  workflow_commit_xmp,
  workflow_snapshot_xmp,
  workflow_restore_xmp,
  workflow_embed_xmp,
  workflow_checkpoint_xmp,
  workflow_variant_filename,
} from '../raw-pipeline/pkg/raw_wasm';
// Metadata needs neither pixel buffers nor Rayon. Never used for render ticks.
const ready = init({ module_or_path: '/raw_wasm_bg.wasm' });
addEventListener(
  'message',
  async (
    event: MessageEvent<{
      id: number;
      operation: 'read' | 'embed' | 'checkpoint' | 'filename' | 'commit' | 'snapshot' | 'restore';
      xmp: string;
      json?: string;
    }>,
  ) => {
    try {
      await ready;
      const convert = () => {
        switch (event.data.operation) {
          case 'commit':
            return workflow_commit_xmp(event.data.xmp, event.data.json!);
          case 'snapshot':
            return workflow_snapshot_xmp(event.data.xmp, event.data.json!);
          case 'restore':
            return workflow_restore_xmp(event.data.xmp, event.data.json!);
          case 'read':
            return workflow_read_xmp(event.data.xmp);
          case 'embed':
            return workflow_embed_xmp(event.data.json!, event.data.xmp);
          case 'checkpoint':
            return workflow_checkpoint_xmp(event.data.xmp);
          case 'filename':
            return workflow_variant_filename(event.data.xmp, event.data.json!);
          default:
            throw Error('Unsupported workflow operation');
        }
      };
      const value = convert();
      postMessage({ id: event.data.id, value });
    } catch (error) {
      postMessage({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
