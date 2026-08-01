import { assertValidSingleFileXmp, isSupportedRaw } from '@maple-common';

export interface SingleFileSelection {
  readonly photo: File;
  readonly xmp?: string;
}

const extension = (filename: string): string => filename.split('.').pop()?.toLowerCase() ?? '';
const stem = (filename: string): string => filename.replace(/\.[^.]+$/, '').toLowerCase();

/** Resolve one photo and its optional same-name XMP from a picker or drop. */
export async function resolveSingleFileSelection(
  files: readonly File[],
): Promise<SingleFileSelection> {
  const xmpFiles = files.filter((file) => extension(file.name) === 'xmp');
  const photos = files.filter(
    (file) =>
      extension(file.name) !== 'xmp' &&
      (isSupportedRaw(file.name) || file.type.startsWith('image/')),
  );
  const unsupported = files.find((file) => !xmpFiles.includes(file) && !photos.includes(file));

  if (unsupported) {
    throw new Error(`“${unsupported.name}” is not a supported RAW or image file.`);
  }
  if (photos.length === 0) throw new Error('Choose a supported RAW or image file.');
  if (photos.length > 1) throw new Error('Choose one photo at a time.');
  if (xmpFiles.length > 1) throw new Error('Choose at most one XMP sidecar.');

  const photo = photos[0];
  const xmpFile = xmpFiles[0];
  if (xmpFile && stem(xmpFile.name) !== stem(photo.name)) {
    throw new Error(`“${xmpFile.name}” does not match “${photo.name}”.`);
  }
  const xmp = xmpFile ? await xmpFile.text() : undefined;
  if (xmp !== undefined) assertValidSingleFileXmp(xmp);
  return { photo, xmp };
}
