export class NativeDetailSupersededError extends Error {
  constructor() {
    super('Native-detail request superseded');
    this.name = 'NativeDetailSupersededError';
  }
}

export interface DetailRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface NativeDetailPixels {
  width: number;
  height: number;
  rgb: Uint8Array;
}
export interface NativeDetailRequest {
  id: number;
  type: 'native-detail';
  sourceId: string;
  bytes?: ArrayBuffer;
  ext: string;
  xmp?: string;
  rect: DetailRect;
  maxLongEdge: number;
  qualityPreview: boolean;
  filmLut?: ArrayBuffer;
}
export interface CloseNativeDetailRequest {
  id: number;
  type: 'close-native-detail';
}
export type NativeDetailResponse =
  | { id: number; type: 'native-detail-success'; width: number; height: number; rgb: ArrayBuffer }
  | { id: number; type: 'native-detail-error'; message: string; superseded?: boolean };

export interface NativeDetailArgs extends Omit<NativeDetailRequest, 'id' | 'type' | 'bytes'> {
  bytes: Uint8Array;
}
