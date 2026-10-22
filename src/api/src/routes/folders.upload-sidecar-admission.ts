/** Raw sidecar uploads bind to the photo family before consuming the body. */
import * as path from 'node:path';
import { lstat, readdir } from '../fs/mirrored';
import { workflowSidecarBase } from '../fs/workflow-sidecar-pairing';
import { PAIRED_SIDECAR_SUFFIX_PATTERN } from '../generated/filename-vocabulary.generated';
import { xmpSidecarPath } from '../fs/xmp';
import { captureSidecarWriteScope } from './xmp-change';
import { primaryReplacementEpoch } from '../fs/primary-replacement-admission';
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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      return info && !info.isDirectory() ? file : null;
    }),
  );
  return owners.filter((file): file is string => file !== null).sort();
}

export async function captureUploadedSidecarAdmission(
  file: string,
): Promise<UploadedSidecarAdmission | undefined> {
  const name = path.basename(file);
  const base = workflowSidecarBase(name) ?? pairedBase.exec(name)?.[1] ?? null;
  if (base === null) return undefined;
  const directory = path.dirname(file);
  const familySidecar = path.join(directory, base + '.xmp');
  // Reject a Replace crossing the asynchronous owner lookup itself. Once
  // admitted, concrete primary identities and the family lane cover the wait.
  const epoch = primaryReplacementEpoch();
  const owners = await familyOwners(familySidecar);
  // Full-name photo backups remain potential members until their uploaded
  // XML can be classified. Reserve their real canonical lane as well.
  const legacyOwner = owners.find((owner) => folded(owner + '.xmp') === folded(familySidecar));
  const primarySidecar = legacyOwner ? xmpSidecarPath(legacyOwner) : familySidecar;
  const scopes = await Promise.all(
    owners.map((owner) => captureSidecarWriteScope(owner, directory)),
  );
  const crossed = epoch !== primaryReplacementEpoch();
  return {
    primarySidecar,
    scope: {
      directory,
      async validate() {
        const current = await familyOwners(familySidecar);
        if (
          crossed ||
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
