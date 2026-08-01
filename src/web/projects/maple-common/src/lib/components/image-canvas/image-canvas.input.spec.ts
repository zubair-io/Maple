import { describe, expect, it, vi } from 'vitest';
import { editorInput } from './image-canvas.input';

describe('editorInput', () => {
  it('keeps supported input bytes unchanged', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const extractEmbeddedPreview = vi.fn();

    await expect(editorInput('photo.RAF', bytes, { extractEmbeddedPreview })).resolves.toEqual({
      bytes,
      ext: 'raf',
    });
    expect(extractEmbeddedPreview).not.toHaveBeenCalled();
  });

  it('uses the embedded JPEG for unsupported X3F sensor input', async () => {
    const raw = new Uint8Array([1, 2, 3]);
    const extractEmbeddedPreview = vi.fn(async () => ({
      width: 1,
      height: 1,
      blob: new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' }),
    }));

    const normalized = await editorInput('photo.X3F', raw, { extractEmbeddedPreview });

    expect(normalized.ext).toBe('jpg');
    expect([...normalized.bytes]).toEqual([4, 5, 6]);
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(raw, 'x3f');
  });
});
