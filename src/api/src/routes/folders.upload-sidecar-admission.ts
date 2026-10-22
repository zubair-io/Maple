/** Raw sidecar uploads bind to the photo family before consuming the body. */
import * as path from 'node:path';
import { lstat, readdir } from '../fs/mirrored';
import { errnoCode } from '../fs/relocate-publish';
import { workflowSidecarBase } from '../fs/workflow-sidecar-pairing';
import { PAIRED_SIDECAR_SUFFIX_PATTERN } from '../generated/filename-vocabulary.generated';
import { xmpSidecarPath } from '../fs/xmp';
import { captureSidecarWriteScope } from './xmp-change';
import { guardPrimaryFamilyLookup } from '../fs/primary-replacement-admission';
import { SidecarWriteBindingChangedError, type SidecarWriteScope } from '../fs/sidecar-write-order';

export interface UploadedSidecarAdmission {
  primarySidecar: string;
  scope: SidecarWriteScope;
}
const pairedBase = new RegExp('^(.+?)' + PAIRED_SIDECAR_SUFFIX_PATTERN + '$', 'i');
const folded = (value: string) => value.normalize('NFC').toLowerCase().normalize('NFC');

async function familyOwners(primarySidecar: string): Promise<string[]> {
  const directory = path.dirname(primarySidecar);
  const candidates = (await readdir(directory))
    .filter((name) => path.extname(name).toLowerCase() !== '.xmp')
    .map((name) => path.join(directory, name))
    .filter(
      (file) =>
        folded(xmpSidecarPath(file)) === folded(primarySidecar) ||
        folded(file + '.xmp') === folded(primarySidecar),
    );
  const owners = await Promise.all(
    candidates.map(async (file) => {
      const info = await lstat(file).catch((error: unknown) => {
        if (errnoCode(error) === 'ENOENT') return null;
        throw error;
      });
      return info && !info.isDirectory() ? file : null;
    }),
  );
  return owners.filter((file): file is string => file !== null).sort();
}

async function preferredFamily(file: string, fallback: string) {
  const literalOwners = await familyOwners(file);
  return literalOwners.length > 0 || file === fallback
    ? { familySidecar: file, owners: literalOwners }
    : { familySidecar: fallback, owners: await familyOwners(fallback) };
}

export async function captureUploadedSidecarAdmission(
  file: string,
): Promise<UploadedSidecarAdmission | undefined> {
  const name = path.basename(file);
  const base = workflowSidecarBase(folded(name)) ?? pairedBase.exec(name)?.[1] ?? null;
  if (base === null) return undefined;
  const directory = path.dirname(file);
  const parsedFamily = path.join(directory, base + '.xmp');
  // Register both candidates before reading either. A real canonical owner
  // takes precedence over suffix-looking stems, including UUID/conflict names.
  const literal = await guardPrimaryFamilyLookup(file, () =>
    guardPrimaryFamilyLookup(parsedFamily, async () => {
      const binding = await preferredFamily(file, parsedFamily);
      const legacyOwner = binding.owners.find(
        (owner) => folded(owner + '.xmp') === folded(binding.familySidecar),
      );
      const lane = legacyOwner ? xmpSidecarPath(legacyOwner) : binding.familySidecar;
      const capturedScopes = await Promise.all(
        binding.owners.map((owner) => captureSidecarWriteScope(owner, directory)),
      );
      return { ...binding, primarySidecar: lane, scopes: capturedScopes };
    }),
  );
  const {
    value: { owners, familySidecar, primarySidecar, scopes },
    crossed: parsedCrossed,
  } = literal.value;
  const crossed = literal.crossed || (familySidecar !== file && parsedCrossed);
  return {
    primarySidecar,
    scope: {
      directory,
      async validate() {
        const currentBinding = await preferredFamily(file, parsedFamily);
        const current = currentBinding.owners;
        if (
          crossed ||
          currentBinding.familySidecar !== familySidecar ||
          current.length !== owners.length ||
          current.some((owner, index) => owner !== owners[index])
        ) {
          throw new SidecarWriteBindingChangedError(
            'Photo family changed; reload before uploading sidecar edits',
          );
        }
        for (const scope of scopes) if (typeof scope !== 'string') await scope.validate();
      },
    },
  };
}
