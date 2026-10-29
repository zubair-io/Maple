import { UNSUPPORTED_CAMERA_MESSAGE_PREFIX } from '../generated/ffi-status.generated.ts';

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

/** The error a develop request rejects with: typed when the child reported an
 * unsupported camera, otherwise the child's message as a plain `Error`. */
export function developRejection(message: string, srcPath: string): Error {
  return message.startsWith(UNSUPPORTED_CAMERA_MESSAGE_PREFIX)
    ? new UnsupportedCameraError(srcPath, message)
    : new Error(message);
}
