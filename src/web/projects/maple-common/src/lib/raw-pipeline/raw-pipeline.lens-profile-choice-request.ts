// Main-thread side of the bundled-Lensfun profile dropdown (#3569). Mirrors
// `raw-pipeline.lens-profile-request.ts`'s `dispatchImportLensProfile`: copy
// the caller's bytes before transferring (the worker takes ownership), post
// through the shared `dispatchWithMark` bracket, register the pending
// handler under this pair's own `PendingHandler` kinds.

import type {
  CompatibleLensProfile,
  LensProfileCompatibleRequest,
  LensProfileEvidence,
  LensProfileEvidenceRequest,
} from '../lens/lens-profile-choice.types';
import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function dispatchCompatibleLensProfiles(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
): Promise<CompatibleLensProfile[]> {
  const buffer = copyBuffer(bytes);
  const request: LensProfileCompatibleRequest = {
    id,
    type: 'lens-profile-compatible',
    bytes: buffer,
    ext,
  };
  return dispatchWithMark<CompatibleLensProfile[]>(
    worker,
    request,
    [buffer],
    'maple:lens-profile-compatible',
    ({ resolve, reject }) => ({ kind: 'lens-profile-compatible', resolve, reject }),
    register,
  );
}

export function dispatchLensProfileEvidence(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
  reference: string,
): Promise<LensProfileEvidence> {
  const buffer = copyBuffer(bytes);
  const request: LensProfileEvidenceRequest = {
    id,
    type: 'lens-profile-evidence',
    bytes: buffer,
    ext,
    reference,
  };
  return dispatchWithMark<LensProfileEvidence>(
    worker,
    request,
    [buffer],
    'maple:lens-profile-evidence',
    ({ resolve, reject }) => ({ kind: 'lens-profile-evidence', resolve, reject }),
    register,
  );
}
