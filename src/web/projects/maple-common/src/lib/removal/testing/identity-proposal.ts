import { RemovalGeneration, removal_content_digest } from '../../raw-pipeline/pkg/raw_wasm';

// Lifecycle/storage tests use an explicit identity-model fixture with actual
// RAW ownership and Rust codecs. Actual ONNX/photo quality have separate gates.
export function identityProposal(
  request: string,
  records: string,
  scene: Float32Array,
  intent: Uint8Array,
  protectedMask: Uint8Array,
) {
  const model = removal_content_digest(new TextEncoder().encode('test identity model fixture'));
  const generation = new RemovalGeneration(
    JSON.stringify({ ...JSON.parse(request), model, model_version: 'test identity fixture' }),
    records,
    scene,
    intent,
    protectedMask,
  );
  try {
    return {
      request: generation.request(),
      mask: intent,
      patch: generation.finish(generation.rgb()),
    };
  } finally {
    generation.free();
  }
}
