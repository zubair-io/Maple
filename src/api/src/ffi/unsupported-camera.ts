import {
  RC_UNSUPPORTED_CAMERA,
  UNSUPPORTED_CAMERA_MESSAGE_PREFIX,
} from '../generated/ffi-status.generated.ts';

/** The decoder has no definition for the camera body, so the original cannot
 * be developed by this build (#5499). The file is intact and develops once a
 * later build supports the body: this is neither a damaged original nor a
 * server fault. */
export class UnsupportedCameraError extends Error {
  override readonly name = 'UnsupportedCameraError';
  constructor(srcPath: string, reason: string) {
    super(`Cannot develop ${srcPath}: ${reason}`);
  }
}

interface FailureLog {
  error(fields: object, message: string): void;
}

/** Whether `maple_render_develop_jpeg_to_file` wrote its output. An unsupported
 * camera throws raw-core's message instead, which reaches the pool as the
 * rejection text that `developRejection` types. */
export function developRenderSucceeded(
  rc: number,
  lastError: () => string | null,
  log: FailureLog,
): boolean {
  if (rc === RC_UNSUPPORTED_CAMERA) {
    throw new Error(String(lastError() ?? `${UNSUPPORTED_CAMERA_MESSAGE_PREFIX}unknown`));
  }
  if (rc !== 0) {
    log.error({ rc, err: lastError() }, 'maple_render_develop_jpeg_to_file failed');
  }
  return rc === 0;
}

/** The error a develop request rejects with: typed when the child reported an
 * unsupported camera, otherwise the child's message as a plain `Error`. */
export function developRejection(message: string, srcPath: string): Error {
  return message.startsWith(UNSUPPORTED_CAMERA_MESSAGE_PREFIX)
    ? new UnsupportedCameraError(srcPath, message)
    : new Error(message);
}
