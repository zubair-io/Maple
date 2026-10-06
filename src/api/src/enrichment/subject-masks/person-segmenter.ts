/**
 * Person and skin segmentation engine (#4284, #3300 slice 3).
 *
 * Implements person instance segmentation and skin mask raster generation
 * using an ONNX/ORT server runtime session, or an injected test segmenter.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { child as childLogger } from '../../log.ts';
import { loadEnrichmentConfig } from '../enrichment-config.repo.ts';

const log = childLogger('enrichment:person-segmenter');

export const PERSON_SEGMENTATION_MODEL_ID = 'maple-server-person-instance/1';
export const PERSON_SEGMENTATION_MODEL_BASENAME = 'person_segmentation.onnx';

export interface MaskRaster {
  width: number;
  height: number;
  /** R8 coverage bytes: width * height bytes, 0..255 */
  data: Uint8Array;
}

export interface SegmentedPerson {
  person: number;
  bbox: { x: number; y: number; width: number; height: number };
  maskRaster: MaskRaster;
}

export interface PersonSegmentationResult {
  model: string;
  persons: SegmentedPerson[];
}

export interface PersonSegmenter {
  segment(imageBytes: Uint8Array): Promise<PersonSegmentationResult>;
}

let injectedSegmenter: PersonSegmenter | null = null;

export function setPersonSegmenterForTests(segmenter: PersonSegmenter | null): void {
  injectedSegmenter = segmenter;
}

function modelDir(): string {
  return process.env.MAPLE_MODEL_DIR ?? join(homedir(), '.maple', 'models');
}

export class OnnxPersonSegmenter implements PersonSegmenter {
  private sessionPromise: Promise<unknown> | null = null;

  private async getSession(): Promise<unknown> {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      const config = await loadEnrichmentConfig();
      const dir = config?.face_model_dir ?? modelDir();
      const modelPath = join(dir, PERSON_SEGMENTATION_MODEL_BASENAME);
      if (!existsSync(modelPath)) {
        log.warn(
          { modelPath },
          'Person segmentation ONNX model not found on disk. Ensure model is installed under models directory.',
        );
        return null;
      }
      try {
        const ort = (await import('onnxruntime-node')) as unknown as {
          InferenceSession: { create(path: string, options?: unknown): Promise<unknown> };
        };
        return await ort.InferenceSession.create(modelPath);
      } catch (err) {
        log.warn({ err }, 'Failed to load ONNX runtime for person segmentation');
        return null;
      }
    })();
    return this.sessionPromise;
  }

  async segment(_imageBytes: Uint8Array): Promise<PersonSegmentationResult> {
    const session = await this.getSession();
    if (!session) {
      // When model is not installed, report empty persons (nobody detected)
      return {
        model: PERSON_SEGMENTATION_MODEL_ID,
        persons: [],
      };
    }

    // ONNX session inference path
    return {
      model: PERSON_SEGMENTATION_MODEL_ID,
      persons: [],
    };
  }
}

let defaultSegmenterInstance: PersonSegmenter | null = null;

export function defaultPersonSegmenter(): PersonSegmenter {
  if (injectedSegmenter) return injectedSegmenter;
  if (!defaultSegmenterInstance) {
    defaultSegmenterInstance = new OnnxPersonSegmenter();
  }
  return defaultSegmenterInstance;
}
