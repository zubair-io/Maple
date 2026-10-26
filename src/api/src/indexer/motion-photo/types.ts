export type MotionVideoMime = 'video/mp4' | 'video/quicktime';

/** Where the embedded clip sits inside the original, as a byte range. */
export interface MotionClip {
  start: number;
  length: number;
  mime: MotionVideoMime;
}

/** A verified clip, or the reason the file is treated as a plain still. */
export type MotionDetection = { motion: MotionClip } | { still: string };

export type StillKind = 'jpeg' | 'heif';

export const still = (reason: string): { still: string } => ({ still: reason });
