/**
 * Upgrade behaviour for a deploy that has never saved a describe server list.
 *
 * The list is the new shape; `describe_provider_url` is the old one. Every
 * existing deploy boots with the old one, so the derivation in between has to
 * preserve what that deploy was already doing — same endpoint, same number of
 * concurrent requests — until the operator opts into per-server tuning.
 */

import { describe, expect, it } from 'bun:test';
import { describeServersForRuntime } from './describe-capacity.ts';
import type { ResolvedEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';

/** Stand-in for the stage's saved concurrency. No database, and — unlike a
 * module mock — nothing that leaks into the suites sharing this process. */
const stageConcurrency = (value: number | null) => async () => value;

function cfg(source: 'db' | 'derived'): ResolvedEnrichmentConfig {
  return {
    describe_provider_url: 'http://ollama.lan:11434',
    describe_servers:
      source === 'db'
        ? [
            { url: 'http://gpu-a:11434', concurrency: 4 },
            { url: 'http://gpu-b:11434', concurrency: 1 },
          ]
        : [{ url: 'http://ollama.lan:11434', concurrency: 2 }],
    source: { describe_servers: source },
  } as ResolvedEnrichmentConfig;
}

describe('describeServersForRuntime', () => {
  it('uses the saved list verbatim once the operator has one', async () => {
    expect(await describeServersForRuntime(cfg('db'), stageConcurrency(5))).toEqual([
      { url: 'http://gpu-a:11434', concurrency: 4 },
      { url: 'http://gpu-b:11434', concurrency: 1 },
    ]);
  });

  it('carries the stage concurrency onto the derived single server', async () => {
    // The upgrade case that matters: this deploy runs describe at 8 against
    // one URL. It must keep running at 8, not drop to the built-in default
    // because a list it never saved says so.
    expect(await describeServersForRuntime(cfg('derived'), stageConcurrency(8))).toEqual([
      { url: 'http://ollama.lan:11434', concurrency: 8 },
    ]);
  });

  it('falls back to the built-in default on a fresh install', async () => {
    expect(await describeServersForRuntime(cfg('derived'), stageConcurrency(null))).toEqual([
      { url: 'http://ollama.lan:11434', concurrency: 2 },
    ]);
  });
});
