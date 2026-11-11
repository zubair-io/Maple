/// <reference lib="webworker" />
import init, {
  workflow_read_xmp,
  workflow_commit_xmp,
  workflow_snapshot_xmp,
  workflow_restore_xmp,
  workflow_embed_xmp,
  workflow_checkpoint_xmp,
  workflow_variant_filename,
  workflow_reconcile_xmp,
  workflow_cursor_xmp,
} from '../raw-pipeline/pkg/raw_wasm';
import { RAW_WASM_URL } from '../raw-pipeline/wasm-asset-url';
const CONVERSIONS: Record<string, (xmp: string, json: string) => string> = {
  commit: workflow_commit_xmp,
  snapshot: workflow_snapshot_xmp,
  restore: workflow_restore_xmp,
  reconcile: (xmp, json) => {
    const { base, incoming, nowMs } = JSON.parse(json);
    return workflow_reconcile_xmp(base, xmp, incoming, nowMs);
  },
  cursor: workflow_cursor_xmp,
  read: workflow_read_xmp,
  embed: (xmp, json) => workflow_embed_xmp(json, xmp),
  checkpoint: workflow_checkpoint_xmp,
  filename: workflow_variant_filename,
};
// Metadata needs neither pixel buffers nor Rayon. Never used for render ticks.
const ready = init({ module_or_path: RAW_WASM_URL });
addEventListener(
  'message',
  async (
    event: MessageEvent<{
      id: number;
      operation:
        | 'read'
        | 'embed'
        | 'checkpoint'
        | 'filename'
        | 'commit'
        | 'snapshot'
        | 'restore'
        | 'reconcile'
        | 'cursor';
      xmp: string;
      json?: string;
    }>,
  ) => {
    try {
      await ready;
      const convert = CONVERSIONS[event.data.operation];
      if (!convert) throw Error('Unsupported workflow operation');
      const value = convert(event.data.xmp, event.data.json!);
      postMessage({ id: event.data.id, value });
    } catch (error) {
      postMessage({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
