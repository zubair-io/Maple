import { assertValidSingleFileXmp, isSupportedRaw } from '@maple-common';

export interface SingleFileSelection {
  readonly photo: File;
  readonly xmp?: string;
}

const extension = (filename: string): string => filename.split('.').pop()?.toLowerCase() ?? '';
const stem = (filename: string): string => filename.replace(/\.[^.]+$/, '').toLowerCase();

const errorReason = (error: unknown): string =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message.trim()
    : '';

function classifySelection(files: readonly File[]): { photo: File; xmpFile?: File } {
  const xmpFiles = files.filter((file) => extension(file.name) === 'xmp');
  const photos = files.filter(
    (file) =>
      extension(file.name) !== 'xmp' &&
      (isSupportedRaw(file.name) || file.type.startsWith('image/')),
  );
  const supported = new Set([...xmpFiles, ...photos]);
  const unsupported = files.find((file) => !supported.has(file));

  if (unsupported) {
    throw new Error(`“${unsupported.name}” is not a supported RAW or image file.`);
  }
  if (photos.length === 0) throw new Error('Choose a supported RAW or image file.');
  if (photos.length > 1) throw new Error('Choose one photo at a time.');
  if (xmpFiles.length > 1) throw new Error('Choose at most one XMP sidecar.');
  return { photo: photos[0], xmpFile: xmpFiles[0] };
}

async function readXmpSidecar(file: File): Promise<string> {
  let xmp: string;
  try {
    xmp = await file.text();
  } catch (error) {
    const reason = errorReason(error);
    throw new Error(`Maple could not read “${file.name}”.${reason ? ` ${reason}` : ''}`, {
      cause: error,
    });
  }
  try {
    assertValidSingleFileXmp(xmp);
  } catch (error) {
    const reason = errorReason(error);
    throw new Error(`“${file.name}” is not a valid sidecar.${reason ? ` ${reason}` : ''}`, {
      cause: error,
    });
  }
  return xmp;
}

/** Resolve one photo and its optional same-name XMP from a picker or drop. */
export async function resolveSingleFileSelection(
  files: readonly File[],
): Promise<SingleFileSelection> {
  const { photo, xmpFile } = classifySelection(files);
  if (xmpFile && stem(xmpFile.name) !== stem(photo.name)) {
    throw new Error(`“${xmpFile.name}” does not match “${photo.name}”.`);
  }
  const xmp = xmpFile ? await readXmpSidecar(xmpFile) : undefined;
  return { photo, xmp };
}
