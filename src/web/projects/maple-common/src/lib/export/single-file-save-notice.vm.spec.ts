// single-file-save-notice.vm.spec.ts — pure function tests, ported from the
// deleted `SingleFileSaveNoticeComponent`'s spec (toast sweep, ticket
// #3043). `HostedEditorRouteComponent.component.spec.ts` covers the DOM/
// click wiring (aria-label, the Download XMP button, no close button); this
// file covers every branch of the mode/status → message projection in
// isolation, no Angular machinery required.

import { describe, expect, it } from 'vitest';
import { noticeViewModel } from './single-file-save-notice.vm';
import type { SingleFileXmpStatus } from '../xmp/single-file-xmp.service';

const NONE_STATUS: SingleFileXmpStatus = {
  assetId: 'asset-1',
  durability: 'none',
  unsaved: false,
};

describe('noticeViewModel', () => {
  it('returns null when there is no focused asset, regardless of mode', () => {
    expect(noticeViewModel('hosted-single-file', NONE_STATUS, false, false)).toBeNull();
  });

  it('returns null for a hosted writable folder', () => {
    expect(noticeViewModel('hosted-writable-folder', NONE_STATUS, false, true)).toBeNull();
  });

  it('returns null in Self Hosted', () => {
    expect(noticeViewModel('self-hosted', NONE_STATUS, false, true)).toBeNull();
  });

  it('returns null when there is no capability policy at all (mode undefined)', () => {
    expect(noticeViewModel(undefined, NONE_STATUS, false, true)).toBeNull();
  });

  it('warns for a hosted read-only folder', () => {
    const notice = noticeViewModel('hosted-read-only-folder', NONE_STATUS, false, true);
    expect(notice?.ariaLabel).toBe('Read-only folder save');
    expect(notice?.message).toContain('This folder is read-only');
  });

  it('warns that a fresh single-file session can’t write a sidecar', () => {
    const notice = noticeViewModel('hosted-single-file', NONE_STATUS, false, true);
    expect(notice?.ariaLabel).toBe('Single-file save');
    expect(notice?.message).toContain('can’t write a sibling .xmp or .maple cache');
  });

  it('makes unsaved single-file edits explicit', () => {
    const status: SingleFileXmpStatus = { assetId: 'asset-1', durability: 'paired', unsaved: true };
    const notice = noticeViewModel('hosted-single-file', status, false, true);
    expect(notice?.message).toContain('only in this browser session');
  });

  it('confirms a paired XMP is durable until another edit', () => {
    const status: SingleFileXmpStatus = {
      assetId: 'asset-1',
      durability: 'paired',
      unsaved: false,
    };
    const notice = noticeViewModel('hosted-single-file', status, false, true);
    expect(notice?.message).toContain('Paired XMP loaded');
  });

  it('confirms a downloaded XMP is durable until another edit', () => {
    const status: SingleFileXmpStatus = {
      assetId: 'asset-1',
      durability: 'downloaded',
      unsaved: false,
    };
    const notice = noticeViewModel('hosted-single-file', status, false, true);
    expect(notice?.message).toContain('XMP downloaded');
  });

  it('appends the memory-only warning when browser storage is unavailable', () => {
    const notice = noticeViewModel('hosted-single-file', NONE_STATUS, true, true);
    expect(notice?.message).toContain(
      'Browser storage is unavailable. Reloading will discard this photo session.',
    );
  });
});
