import type { EmbeddedPreviewService } from '../../raw-pipeline/embedded-preview.service';

export interface EditorInput {
  readonly bytes: Uint8Array;
  readonly ext: string;
}

/**
 * Normalize source bytes into an input the editor's supported decode path can
 * consume. X3F sensor decode remains unsupported (#417), so its oriented,
 * camera-rendered JPEG is used without ever modifying the original bytes.
 */
export async function editorInput(
  filename: string,
  bytes: Uint8Array,
  embeddedPreview: Pick<EmbeddedPreviewService, 'extractEmbeddedPreview'>,
): Promise<EditorInput> {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext !== 'x3f') return { bytes, ext };

  const preview = await embeddedPreview.extractEmbeddedPreview(bytes, ext);
  return {
    bytes: new Uint8Array(await preview.blob.arrayBuffer()),
    ext: 'jpg',
  };
}
