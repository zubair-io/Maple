import { describe, expect, it } from 'vitest';
import { HOSTED_WORKSPACE_POLICY, SELF_HOSTED_WORKSPACE_POLICY } from './workspace-capabilities';

describe('workspace capability policies', () => {
  it('requires XMP download for a Hosted single-file workspace', () => {
    expect(HOSTED_WORKSPACE_POLICY.resolve(false)).toEqual({
      mode: 'hosted-single-file',
      xmpSave: 'download',
      mapleCacheWrite: false,
      serverBacked: false,
    });
  });

  it('allows sibling XMP and .maple writes for a Hosted writable folder', () => {
    expect(HOSTED_WORKSPACE_POLICY.resolve(true)).toEqual({
      mode: 'hosted-writable-folder',
      xmpSave: 'sibling',
      mapleCacheWrite: true,
      serverBacked: false,
    });
  });

  it('keeps Self Hosted server persistence independent of browser folder handles', () => {
    expect(SELF_HOSTED_WORKSPACE_POLICY.resolve(false)).toEqual(
      SELF_HOSTED_WORKSPACE_POLICY.resolve(true),
    );
    expect(SELF_HOSTED_WORKSPACE_POLICY.resolve(false)).toEqual({
      mode: 'self-hosted',
      xmpSave: 'sibling',
      mapleCacheWrite: true,
      serverBacked: true,
    });
  });
});
