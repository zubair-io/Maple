import { GoogleConnectionError } from '../cloud-backup/google/config.ts';
import { Elysia, t } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import {
  callbackUrl,
  FLOW_COOKIE,
  FLOW_TTL,
  GOOGLE_CALLBACK_PATH,
  publicConfig,
} from '../cloud-backup/google/config.ts';
import { loadConnection, reserveRoot, saveConfig } from '../cloud-backup/google/repo.ts';
import {
  startGoogleFlow,
  finishGoogleFlow,
  googleAccessToken,
  type GoogleFetch,
} from '../cloud-backup/google/oauth.ts';
import {
  createGoogleRoot,
  DriveClient,
  validateGoogleRoot,
} from '../cloud-backup/google/client.ts';
import {
  configuredGoogleClient,
  type GoogleConfigPatch,
} from '../cloud-backup/google/configuration.ts';

export interface GoogleRouteDependencies {
  origin: () => Promise<string>;
  destination: (
    id: string,
  ) => Promise<{ kind: string; rootId: string | null; generation: number } | null>;
  attachRoot: (id: string, rootId: string, accountId: string, generation: number) => Promise<void>;
  connectionChanged: (id: string) => Promise<void>;
  transport?: GoogleFetch;
}
const IdParams = t.Object({ destinationId: t.String({ format: 'uuid' }) });
const ConfigBody = t.Object({
  clientMode: t.Optional(t.Union([t.Literal('maple'), t.Literal('own')])),
  clientId: t.Optional(t.String({ maxLength: 256 })),
  clientSecret: t.Optional(t.Union([t.String({ maxLength: 4096 }), t.Null()])),
  callbackMode: t.Union([t.Literal('direct'), t.Literal('relay')]),
  rootId: t.Optional(t.String({ maxLength: 200 })),
});
const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function flowCookie(value: string, callback: string, maxAge: number) {
  return `${FLOW_COOKIE}=${value}; Path=${GOOGLE_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${callback.startsWith('https:') ? '; Secure' : ''}`;
}
function cookieValue(request: Request) {
  const match = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FLOW_COOKIE}=`));
  return match?.slice(FLOW_COOKIE.length + 1) ?? '';
}
const errorMessage = (error: unknown) =>
  error instanceof GoogleConnectionError
    ? error.message
    : 'Google connection failed; check your settings and retry.';

/** Owner routes and the single cookie/state guarded browser callback must be
 * mounted as separate sub-apps, outside the ordinary bearer-gated subtree. */
export function buildGoogleBackupRoutes(deps: GoogleRouteDependencies) {
  const requireDestination = async (id: string) => {
    const destination = await deps.destination(id);
    if (!destination || destination.kind !== 'google-drive')
      throw new GoogleConnectionError('Google backup destination does not exist.');
    return destination;
  };
  const projection = async (id: string) => {
    const destination = await requireDestination(id);
    const connection = await loadConnection(id);
    const callback = await deps
      .origin()
      .then(callbackUrl)
      .catch(() => null);
    return {
      ...publicConfig(connection.config, callback),
      rootId: destination.rootId,
    };
  };
  const configure = async (id: string, body: GoogleConfigPatch) => {
    const destination = await requireDestination(id);
    const current = await loadConnection(id);
    const { changed, config } = await configuredGoogleClient(body, current.config, deps.transport);
    if (
      destination.rootId &&
      (config.clientMode !== current.config.clientMode ||
        config.clientId !== current.config.clientId)
    )
      throw new GoogleConnectionError(
        'This backup folder belongs to its current OAuth client. Create another destination to change applications.',
      );
    if (changed) {
      // Fence before saving: an old-generation request cannot publish in an
      // await gap between the credential change and destination invalidation.
      await deps.connectionChanged(id);
      if (!(await saveConfig(id, config, current.epoch, destination.rootId)))
        throw new GoogleConnectionError('Configuration changed; reload and retry.');
    }
    if (body.rootId && body.rootId !== destination.rootId) {
      if (!config.refreshToken)
        throw new GoogleConnectionError(
          'Connect Google Drive before attaching an existing backup folder.',
        );
      await validateGoogleRoot(
        new DriveClient(() => googleAccessToken(id, deps.transport), deps.transport),
        body.rootId,
      );
      await deps.attachRoot(id, body.rootId, config.accountId!, destination.generation);
    }
  };
  const owner = new Elysia({
    name: 'googleBackupOwner',
    prefix: '/api/cloud-backup/google',
  })
    .use(requireAuth)
    .use(requireOwner)
    .get('/:destinationId/config', ({ params }) => projection(params.destinationId), {
      params: IdParams,
    })
    .put(
      '/:destinationId/config',
      async ({ params, body, set }) => {
        try {
          await configure(params.destinationId, body);
          return await projection(params.destinationId);
        } catch (error) {
          set.status = 400;
          return { error: errorMessage(error) };
        }
      },
      { params: IdParams, body: ConfigBody },
    )
    .post(
      '/:destinationId/start',
      async ({ params, auth, request, set }) => {
        try {
          await requireDestination(params.destinationId);
          const origin = await deps.origin();
          const callback = callbackUrl(origin);
          const browserOrigin = request.headers.get('origin') ?? new URL(request.url).origin;
          if (browserOrigin !== new URL(callback).origin)
            throw new GoogleConnectionError(
              'Open Maple through the configured callback domain before connecting Google Drive.',
            );
          const result = await startGoogleFlow(
            params.destinationId,
            auth.user.sub,
            origin,
            deps.transport,
          );
          Object.assign(set.headers, safeHeaders, {
            'Set-Cookie': flowCookie(result.cookie, callback, FLOW_TTL / 1000),
          });
          return { authorizationUrl: result.authorizationUrl };
        } catch (error) {
          set.status = 400;
          return { error: errorMessage(error) };
        }
      },
      { params: IdParams },
    )
    .post(
      '/:destinationId/disconnect',
      async ({ params }) => {
        await requireDestination(params.destinationId);
        const current = await loadConnection(params.destinationId);
        await deps.connectionChanged(params.destinationId);
        if (
          !(await saveConfig(
            params.destinationId,
            { ...current.config, refreshToken: null, relayGrant: null },
            current.epoch,
          ))
        )
          throw new GoogleConnectionError('Configuration changed; reload and retry.');
        return projection(params.destinationId);
      },
      { params: IdParams },
    )
    .post(
      '/:destinationId/root',
      async ({ params, set }) => {
        try {
          const destination = await requireDestination(params.destinationId);
          if (destination.rootId)
            throw new GoogleConnectionError('This destination already has a backup root.');
          const connection = await loadConnection(params.destinationId);
          const token = () => googleAccessToken(params.destinationId, deps.transport);
          const reserved = await reserveRoot(
            params.destinationId,
            connection.epoch,
            await new DriveClient(token, deps.transport).reserveId(),
          );
          const rootId = await createGoogleRoot(token, deps.transport, reserved);
          if ((await loadConnection(params.destinationId)).epoch !== connection.epoch)
            throw new GoogleConnectionError(
              'Connection changed; attach the created Maple folder after reconnecting.',
            );
          await deps.attachRoot(
            params.destinationId,
            rootId,
            connection.config.accountId!,
            destination.generation,
          );
          return projection(params.destinationId);
        } catch (error) {
          set.status = 400;
          return { error: errorMessage(error) };
        }
      },
      { params: IdParams },
    );
  const callback = new Elysia({ name: 'googleBackupCallback' }).get(
    GOOGLE_CALLBACK_PATH,
    async ({ request }) => {
      const url = new URL(request.url);
      try {
        const origin = await deps.origin();
        const expected = callbackUrl(origin);
        // A TLS terminating reverse proxy may give Bun an internal HTTP URL.
        // Authority is the fixed route + host-only Secure cookie + exact bound
        // state and configured origin, never Host/Forwarded-derived routing.
        const destinationId = await finishGoogleFlow(
          url.searchParams.get('state') ?? '',
          cookieValue(request),
          url.searchParams.get('code'),
          url.searchParams.has('error'),
          deps.origin,
          deps.transport,
        );
        await requireDestination(destinationId);
        await deps.connectionChanged(destinationId);
        return new Response(null, {
          status: 303,
          headers: {
            ...safeHeaders,
            'Set-Cookie': flowCookie('', expected, 0),
            Location: `${new URL(expected).origin}/settings/backup?connected=${destinationId}`,
          },
        });
      } catch (error) {
        const expected = await deps
          .origin()
          .then(callbackUrl)
          .catch(() => null);
        if (!expected)
          return new Response(errorMessage(error), { status: 400, headers: safeHeaders });
        const destination = new URL('/settings/backup', new URL(expected).origin);
        destination.searchParams.set('googleError', errorMessage(error));
        return new Response(null, {
          status: 303,
          headers: {
            ...safeHeaders,
            'Set-Cookie': flowCookie('', expected, 0),
            Location: destination.toString(),
          },
        });
      }
    },
  );
  return { owner, callback };
}
