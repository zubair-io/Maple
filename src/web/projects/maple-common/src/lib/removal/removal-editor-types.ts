import type { Asset } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { RemovalProposal } from './removal-inference.types';
import type { RemovalAssets } from './removal-assets.types';

export interface OpenRemovalPhoto {
  asset: Asset;
  folder: MapleFolderHandle | undefined;
  path?: string;
  readOriginal: () => Promise<Uint8Array>;
  model: AdjustmentModel;
  xml: string;
  source: string;
  width: number;
  height: number;
  prior: string;
  companions: Map<string, Uint8Array>;
  assets: RemovalAssets;
  sidecarRevision: string;
}

export interface RemovalDraft {
  records: string;
  xml: string;
  proposals: RemovalProposal[];
  companions: Map<string, Uint8Array>;
}
