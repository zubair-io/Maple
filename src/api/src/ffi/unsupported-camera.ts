/** raw-core's `Error::UnsupportedCamera` message, which crosses the FFI child's
 * IPC boundary as plain text. */
const UNSUPPORTED_CAMERA_MESSAGE = /^unsupported camera: /;

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
  return UNSUPPORTED_CAMERA_MESSAGE.test(message)
    ? new UnsupportedCameraError(srcPath, message)
    : new Error(message);
}
