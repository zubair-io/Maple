/// <reference lib="webworker" />
import { removal_content_digest, removal_selection } from './pkg/raw_wasm';
import { ensureReady } from './raw-pipeline.worker-handlers';
import { withLiveRemovalSession } from './raw-pipeline.session-handler';
import { withNativeRemovalSession } from './raw-pipeline.native-detail-handler';
import { restoreLensProfile } from './raw-pipeline.lens-profile';
import type {
  RemovalAuthoringRequest,
  RemovalAuthoringResponse,
  RemovalAuthoringValue,
  RemovalRawSession,
} from './raw-pipeline.removal.types';

/** The same implementation is driven by real retained WASM tests. The source
 * binding is checked on every gesture/context request, not only at tool open. */
export function runRemovalAuthoring(
  session: RemovalRawSession,
  request: RemovalAuthoringRequest,
): RemovalAuthoringValue {
  const source = session.removal_calibration_source();
  const anchor: unknown = JSON.parse(source);
  if (
    typeof anchor !== 'object' ||
    !anchor ||
    !('original' in anchor) ||
    !('width' in anchor) ||
    !('height' in anchor) ||
    typeof anchor.original !== 'string' ||
    typeof anchor.width !== 'number' ||
    typeof anchor.height !== 'number'
  )
    throw new Error('Invalid removal source anchor');
  const command = request.command;
  const original =
    command.kind === 'source'
      ? removal_content_digest(new Uint8Array(command.bytes))
      : request.original;
  if (!original || original !== anchor.original) {
    throw new Error('Removal RAW source changed; reopen the tool');
  }
  switch (command.kind) {
    case 'source':
      return { kind: 'source', source };
    case 'map':
      return { kind: 'map', mapping: session.removal_map_points(command.xmp, command.request) };
    case 'context':
    case 'generation-context': {
      if (
        !command.rect.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
      ) {
        throw new Error('Invalid native removal context rectangle');
      }
      if (command.kind === 'generation-context') {
        session.prepare_saved_removals(
          command.xmp,
          command.manifest,
          new Uint8Array(command.companions),
        );
      }
      const rgb =
        command.kind === 'context'
          ? session.removal_calibration_context(new Uint32Array(command.rect))
          : session.removal_generation_context(command.xmp, new Uint32Array(command.rect));
      return {
        kind: 'context',
        rgb: rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength) as ArrayBuffer,
      };
    }
    case 'prepare-saved':
      return {
        kind: 'prepared',
        review: session.prepare_saved_removals(
          command.xmp,
          command.manifest,
          new Uint8Array(command.companions),
        ),
      };
    case 'selection': {
      const mask = removal_selection(anchor.width, anchor.height, command.request);
      return {
        kind: 'selection',
        mask: mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength) as ArrayBuffer,
      };
    }
  }
}

export async function handleRemovalAuthoring(request: RemovalAuthoringRequest): Promise<void> {
  try {
    await ensureReady();
    if (request.command.kind === 'map') await restoreLensProfile(request.command.xmp);
    const live = await withLiveRemovalSession((session) => runRemovalAuthoring(session, request));
    const value = live
      ? live.value
      : await withNativeRemovalSession(
          request.sourceId,
          request.ext,
          request.command.kind === 'source' ? request.command.bytes : undefined,
          (session) => runRemovalAuthoring(session as unknown as RemovalRawSession, request),
        );
    const reply: RemovalAuthoringResponse = {
      id: request.id,
      type: 'removal-authoring-success',
      value,
    };
    const transfer =
      value.kind === 'context' ? [value.rgb] : value.kind === 'selection' ? [value.mask] : [];
    self.postMessage(reply, transfer);
  } catch (error) {
    const reply: RemovalAuthoringResponse = {
      id: request.id,
      type: 'removal-authoring-error',
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
}
