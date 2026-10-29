import { describe, expect, it } from 'bun:test';
import {
  RC_UNSUPPORTED_CAMERA,
  UNSUPPORTED_CAMERA_MESSAGE_PREFIX,
} from '../generated/ffi-status.generated.ts';
import {
  developRejection,
  developRenderSucceeded,
  UnsupportedCameraError,
} from './unsupported-camera.ts';

function recordingLog() {
  const entries: { fields: object; message: string }[] = [];
  return { entries, error: (fields: object, message: string) => entries.push({ fields, message }) };
}

describe('developRenderSucceeded (#5499)', () => {
  it('reports a written develop without logging', () => {
    const log = recordingLog();
    expect(developRenderSucceeded(0, () => null, log)).toBe(true);
    expect(log.entries).toEqual([]);
  });

  it('logs an ordinary render failure and reports nothing written', () => {
    const log = recordingLog();
    expect(developRenderSucceeded(7, () => 'decode failed', log)).toBe(false);
    expect(log.entries).toEqual([
      {
        fields: { rc: 7, err: 'decode failed' },
        message: 'maple_render_develop_jpeg_to_file failed',
      },
    ]);
  });

  it("throws raw-core's message for an unsupported camera so the pool can type it", () => {
    const log = recordingLog();
    const message = `${UNSUPPORTED_CAMERA_MESSAGE_PREFIX}Hasselblad Hasselblad H2D`;
    expect(() => developRenderSucceeded(RC_UNSUPPORTED_CAMERA, () => message, log)).toThrow(
      message,
    );
    expect(log.entries).toEqual([]);
  });

  it('still throws a recognisable message when the native side left none', () => {
    const thrown = (() => {
      try {
        developRenderSucceeded(RC_UNSUPPORTED_CAMERA, () => null, recordingLog());
      } catch (err) {
        return err as Error;
      }
    })();
    expect(developRejection(thrown!.message, '/photos/frame.3fr')).toBeInstanceOf(
      UnsupportedCameraError,
    );
  });
});
