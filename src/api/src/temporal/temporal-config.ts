/**
 * Where Maple finds its Temporal server, and what the worker tier last saw
 * there. One `app_settings` document: the API process writes the address and
 * namespace, the worker process writes `connection`, and neither touches the
 * other's keys.
 *
 * Resolution order for the address: saved setting → `MAPLE_TEMPORAL_ADDRESS` →
 * default. The environment exists for one case, a deployment that wires
 * Temporal in as a sibling service (`docker-compose.yml`) and has to work before
 * anyone has opened Settings → Workers.
 */

import { patchAppSettings, readAppSettings } from '../db/repos/app-settings.repo.ts';

const DOC_ID = 'temporal';

export const DEFAULT_TEMPORAL_ADDRESS = '127.0.0.1:7233';
export const DEFAULT_TEMPORAL_NAMESPACE = 'default';

/** A report older than this means the worker tier is not running, whatever it last said. */
const REPORT_STALE_MS = 45_000;

const ADDRESS_PATTERN = /^(?:[A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export interface TemporalSettings {
  address: string;
  namespace: string;
}

export interface TemporalConnectionReport extends TemporalSettings {
  state: 'connected' | 'unreachable';
  error: string | null;
  checkedAt: number;
}

export interface TemporalStatus extends TemporalSettings {
  connection: {
    state: 'connected' | 'unreachable' | 'unknown';
    error: string | null;
    checkedAt: number | null;
  };
}

interface TemporalDoc {
  address?: string;
  namespace?: string;
  connection?: TemporalConnectionReport;
}

export class TemporalSettingsError extends Error {
  override name = 'TemporalSettingsError';
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value.trim() : undefined;

function resolveSettings(doc: TemporalDoc | null): TemporalSettings {
  return {
    address:
      nonEmpty(doc?.address) ??
      nonEmpty(process.env.MAPLE_TEMPORAL_ADDRESS) ??
      DEFAULT_TEMPORAL_ADDRESS,
    namespace: nonEmpty(doc?.namespace) ?? DEFAULT_TEMPORAL_NAMESPACE,
  };
}

export async function loadTemporalSettings(): Promise<TemporalSettings> {
  return resolveSettings(await readAppSettings<TemporalDoc>(DOC_ID));
}

export async function saveTemporalSettings(input: TemporalSettings): Promise<void> {
  const address = input.address.trim();
  const namespace = input.namespace.trim();
  const port = Number(ADDRESS_PATTERN.exec(address)?.[1]);
  if (!(port >= 1 && port <= 65_535)) {
    throw new TemporalSettingsError('The address must be host:port, for example temporal:7233');
  }
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new TemporalSettingsError(
      'The namespace may contain letters, digits, dots, dashes and underscores',
    );
  }
  await patchAppSettings(DOC_ID, { address, namespace });
}

export async function reportTemporalConnection(report: TemporalConnectionReport): Promise<void> {
  await patchAppSettings(DOC_ID, { connection: report });
}

/** A report only counts while it is fresh and about the settings currently saved. */
function currentReport(
  settings: TemporalSettings,
  report: TemporalConnectionReport | undefined,
  nowMs: number,
): TemporalConnectionReport | null {
  if (report === undefined) return null;
  const sameTarget = report.address === settings.address && report.namespace === settings.namespace;
  return sameTarget && nowMs - report.checkedAt <= REPORT_STALE_MS ? report : null;
}

export async function readTemporalStatus(nowMs: number = Date.now()): Promise<TemporalStatus> {
  const doc = await readAppSettings<TemporalDoc>(DOC_ID);
  const settings = resolveSettings(doc);
  const report = currentReport(settings, doc?.connection, nowMs);
  return {
    ...settings,
    connection:
      report === null
        ? { state: 'unknown', error: null, checkedAt: doc?.connection?.checkedAt ?? null }
        : { state: report.state, error: report.error, checkedAt: report.checkedAt },
  };
}
