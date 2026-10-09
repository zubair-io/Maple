/**
 * The ordered migration list for the SQLite backend.
 *
 * Append only. An id that has shipped is frozen — live databases carry it in
 * `schema_migrations`, and `assertMigrationOrder` refuses a list whose ids are
 * not in ascending order, so a new migration goes at the bottom with a higher
 * number and never in the middle.
 *
 * Nothing in this epic had shipped while it was being built, so the initial
 * schema is one migration: every correction the port slices found went into it
 * rather than into a rebuild on top of it. A database that records
 * `0001-initial-schema` never re-runs it, so the freeze starts at the cutover
 * (#3752) and not before — and `0002` is the first change that landed after a
 * real library was already carrying `0001`.
 *
 * A number is claimed by whichever change merges first, not by whichever was
 * written first: `0003-facet-state` was authored as `0002` and renumbered when
 * `0002-stage-state-media-kind` landed ahead of it. That is the whole cost of
 * the rule, and it is cheap — two branches that both ship a `0002` would leave
 * two installs recording the same id for different schemas, which nothing
 * downstream could tell apart.
 */

import type { Migration } from '../migrate.ts';
import { initialSchemaMigration } from './0001-initial-schema.ts';
import { stageStateMediaKindMigration } from './0002-stage-state-media-kind.ts';
import { facetStateMigration } from './0003-facet-state.ts';
import { stageStateAssetClaimableMigration } from './0004-stage-state-asset-claimable.ts';
import { optionalUserEmailMigration } from './0005-optional-user-email.ts';
import { emailFreeInvitesMigration } from './0006-email-free-invites.ts';
import { assetWorkingSetSortMigration } from './0007-asset-working-set-sort.ts';
import { removeUnusedIndexerQueueMigration } from './0008-remove-unused-indexer-queue.ts';
import { unicodePresetEmailKeysMigration } from './0009-unicode-preset-email-keys.ts';
import { removeUnusedImageCapabilitiesMigration } from './0010-remove-unused-image-capabilities.ts';
import { assetOwnerIdMigration } from './0011-asset-owner-id.ts';
import { greekSigmaIdentityKeysMigration } from './0012-greek-sigma-identity-keys.ts';
import { ownerCapturePaginationMigration } from './0013-owner-capture-pagination.ts';
import { cloudBackupMigration } from './0014-cloud-backup.ts';
import { personSegmentationsMigration } from './0015-person-segmentations.ts';
import { cloudBackupDestinationStatusMigration } from './0016-cloud-backup-destination-status.ts';
import { cloudBackupObjectEntryIndexMigration } from './0017-cloud-backup-object-entry-index.ts';
import { cloudBackupGoogleMirrorLayoutMigration } from './0018-cloud-backup-google-mirror-layout.ts';
import { assetsLiveMonthMigration } from './0019-assets-live-month.ts';
import { assetsUnlistedMigration } from './0020-assets-unlisted.ts';
import { workerStatusMemoryMigration } from './0021-worker-status-memory.ts';

export const ALL_MIGRATIONS: readonly Migration[] = [
  initialSchemaMigration,
  stageStateMediaKindMigration,
  facetStateMigration,
  stageStateAssetClaimableMigration,
  optionalUserEmailMigration,
  emailFreeInvitesMigration,
  assetWorkingSetSortMigration,
  removeUnusedIndexerQueueMigration,
  unicodePresetEmailKeysMigration,
  removeUnusedImageCapabilitiesMigration,
  assetOwnerIdMigration,
  greekSigmaIdentityKeysMigration,
  ownerCapturePaginationMigration,
  cloudBackupMigration,
  personSegmentationsMigration,
  cloudBackupDestinationStatusMigration,
  cloudBackupObjectEntryIndexMigration,
  cloudBackupGoogleMirrorLayoutMigration,
  assetsLiveMonthMigration,
  assetsUnlistedMigration,
  workerStatusMemoryMigration,
];
