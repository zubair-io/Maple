// The two actual storage owners have the same accepted-asset operations (#3984).
import type { LocalRemovalAssets } from './local-removal-assets';
import type { ServerRemovalAssets } from './server-removal-assets';

export type RemovalAssets = LocalRemovalAssets | ServerRemovalAssets;
