import { takeRenderFrame } from './raw-pipeline.render-frame';
/// <reference lib="webworker" />
import {
  NativeDetailSession,
  RemovalMask,
  removal_content_digest,
  removal_refine_selection,
  removal_selection,
} from './pkg/raw_wasm';
import { ensureReady } from './raw-pipeline.worker-handlers';
import { withLiveRemovalSession } from './raw-pipeline.session-handler';
import { withNativeRemovalSession } from './raw-pipeline.native-detail-handler';
import { restoreLensProfile } from './raw-pipeline.lens-profile';
import type {
  RemovalAuthoringRequest,
  RemovalAuthoringResponse,
  RemovalAuthoringValue,
  RemovalRawSession,
  RemovalAuthoringCommand,
} from './raw-pipeline.removal.types';

/** A cache render is one atomic cold operation on a temporary CPU RAW, not
 * the live GPU or native-detail object carrying an unsaved editor review. */
export function runRemovalDerivative(
  ext: string,
  command: Extract<RemovalAuthoringCommand, { kind: 'derivative' }>,
): RemovalAuthoringValue {
  const session = new NativeDetailSession(new Uint8Array(command.bytes), ext);
  try {
    session.prepare_saved_removals(
      command.xmp,
      command.manifest,
      new Uint8Array(command.companions),
    );
    return {
      kind: 'rendered',
      frame: takeRenderFrame(
        session.render_saved_preview(
          command.xmp,
          command.cap,
          command.film ? new Uint8Array(command.film) : new Uint8Array(),
        ),
      ),
    };
  } finally {
    session.free();
  }
}

/** The same implementation is driven by real retained WASM tests. The source
 * binding is checked on every gesture/context request, not only at tool open. */
export function runRemovalAuthoring(
  session: RemovalRawSession,
  request: RemovalAuthoringRequest,
): RemovalAuthoringValue {
  if (request.command.kind === 'derivative')
    return runRemovalDerivative(request.ext, request.command);
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
    case 'proxy': {
      if (!session.removal_selection_proxy) throw new Error('Selection proxy renderer unavailable');
      const proxy = session.removal_selection_proxy(command.xmp);
      try {
        return {
          kind: 'proxy',
          width: proxy.width,
          height: proxy.height,
          rgb: proxy.take_rgb().slice().buffer as ArrayBuffer,
        };
      } finally {
        proxy.free();
      }
    }
    case 'render-saved': {
      if (!session.render_saved_preview) throw new Error('Saved preview renderer unavailable');
      return {
        kind: 'rendered',
        frame: takeRenderFrame(
          session.render_saved_preview(
            command.xmp,
            command.cap,
            command.film ? new Uint8Array(command.film) : new Uint8Array(),
          ),
        ),
      };
    }
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
    case 'refine-selection': {
      const base = new Uint8Array(command.base);
      for (const bytes of [base, new Uint8Array(command.protection)]) {
        if (!bytes.length && bytes !== base) continue;
        const decoded = new RemovalMask(bytes);
        const geometry = decoded.geometry();
        decoded.free();
        if (geometry[0] !== anchor.width || geometry[1] !== anchor.height)
          throw new Error('Person mask belongs to a different RAW geometry');
      }
      const mask = removal_refine_selection(
        base,
        new Uint8Array(command.protection),
        command.request,
      );
      return { kind: 'selection', mask: mask.slice().buffer as ArrayBuffer };
    }
  }
}

export async function handleRemovalAuthoring(request: RemovalAuthoringRequest): Promise<void> {
  try {
    await ensureReady();
    if (
      request.command.kind === 'map' ||
      request.command.kind === 'render-saved' ||
      request.command.kind === 'derivative'
    )
      await restoreLensProfile(request.command.xmp);
    const live =
      request.command.kind === 'derivative'
        ? null
        : await withLiveRemovalSession(
            (session) => runRemovalAuthoring(session, request),
            request.command.kind === 'prepare-saved' ||
              request.command.kind === 'generation-context',
          );
    const value =
      request.command.kind === 'derivative'
        ? runRemovalDerivative(request.ext, request.command)
        : live
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
      value.kind === 'context' || value.kind === 'proxy'
        ? [value.rgb]
        : value.kind === 'selection'
          ? [value.mask]
          : value.kind === 'rendered'
            ? [value.frame.rgb]
            : [];
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
