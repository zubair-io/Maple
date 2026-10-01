/// <reference lib="webworker" />
import { RemovalInferenceEngine } from './removal-inference.engine';
import type { RemovalInferenceMessage, RemovalInferenceReply } from './removal-inference.types';

const engine = new RemovalInferenceEngine();
let serial = Promise.resolve();
addEventListener('message', (event: MessageEvent<RemovalInferenceMessage>) => {
  const message = event.data;
  serial = serial.then(async () => {
    try {
      const result = await engine.execute(message.command, (stage) => {
        postMessage({ id: message.id, stage } satisfies RemovalInferenceReply);
      });
      const transfer =
        (result instanceof Float32Array || result instanceof Uint8Array) &&
        result.buffer instanceof ArrayBuffer
          ? [result.buffer]
          : [];
      postMessage({ id: message.id, result } satisfies RemovalInferenceReply, transfer);
    } catch (error) {
      postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies RemovalInferenceReply);
    }
  });
});
