import { GoogleConnectionError } from './config.ts';
import { createHash, randomBytes } from 'node:crypto';
import { sqliteDb } from '../../db/repos/db-handle.ts';
import {
  DRIVE_SCOPE,
  FLOW_TTL,
  RELAY_CALLBACK,
  RELAY_ORIGIN,
  callbackUrl,
  validateDirectCallback,
} from './config.ts';
import {
  loadConnection,
  savePending,
  consumePending,
  commitTokens,
  claimRefresh,
  releaseRefresh,
  type PendingFlow,
} from './repo.ts';

export type GoogleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
const timeout = () => AbortSignal.timeout(30_000);
const hashCookie = (cookie: string) => createHash('sha256').update(cookie).digest('hex');
const cache = new Map<string, { epoch: number; token: string; expires: number }>();
class GoogleReconnectRequired extends GoogleConnectionError {}

async function ownerStillAuthorized(id: string) {
  const [owner] = await sqliteDb().read<{ role: string }>('SELECT role FROM users WHERE id = ?', [
    id,
  ]);
  if (owner?.role !== 'owner')
    throw new GoogleConnectionError('An active Maple owner must connect Google Drive.');
}

/** Google failures are classified without reflecting response bodies or secrets. */
async function tokenRequest(params: URLSearchParams, transport: GoogleFetch) {
  const response = await transport('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    signal: timeout(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) tokenFailure(body);
  return parseTokens(body);
}
function tokenFailure(body: Record<string, unknown>): never {
  if (body.error === 'invalid_grant')
    throw new GoogleReconnectRequired('Authorization expired or revoked; reconnect Google Drive.');
  if (body.error === 'invalid_client')
    throw new GoogleConnectionError('Check the Web Application Client ID and Client Secret.');
  throw new GoogleConnectionError(
    'Google token request failed; check application permissions and retry Connect.',
  );
}
function parseTokens(body: Record<string, unknown>) {
  if (
    typeof body.access_token !== 'string' ||
    body.access_token.length > 8192 ||
    typeof body.expires_in !== 'number' ||
    body.expires_in <= 0 ||
    body.token_type !== 'Bearer'
  ) {
    throw new GoogleConnectionError(
      'Google returned an unusable access token; reconnect Google Drive.',
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
  };
}

async function verifyScopes(
  accessToken: string,
  clientId: string,
  transport: GoogleFetch,
): Promise<void> {
  // Matches Google's official Node OAuth2Client.getTokenInfo: POST + Bearer,
  // so tokens never enter URLs. Always verify effective scopes, even if omitted
  // from the token exchange response.
  const metadata = await transport('https://oauth2.googleapis.com/tokeninfo', {
    method: 'POST',
    redirect: 'error',
    signal: timeout(),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (!metadata.ok)
    throw new GoogleConnectionError('Google token verification failed; reconnect Google Drive.');
  const info = (await metadata.json()) as {
    aud?: string;
    azp?: string;
    scope?: string;
  };
  if (
    info.aud !== clientId ||
    (info.azp && info.azp !== clientId) ||
    info.scope?.split(' ').filter(Boolean).join(' ') !== DRIVE_SCOPE
  ) {
    throw new GoogleConnectionError(
      'Google must grant only drive.file to this exact OAuth client. Use a dedicated project.',
    );
  }
}
async function verifyToken(accessToken: string, clientId: string, transport: GoogleFetch) {
  await verifyScopes(accessToken, clientId, transport);
  return loadGoogleAccount(accessToken, transport);
}
async function loadGoogleAccount(accessToken: string, transport: GoogleFetch) {
  const account = await transport(
    'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)',
    {
      redirect: 'error',
      signal: timeout(),
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!account.ok)
    throw new GoogleConnectionError(
      'Enable Google Drive API and allow this application in Workspace policy.',
    );
  const { user } = (await account.json()) as {
    user?: { permissionId?: string; emailAddress?: string };
  };
  if (!user?.permissionId)
    throw new GoogleConnectionError('Google Drive account identity unavailable.');
  return {
    accountId: user.permissionId,
    accountEmail: user.emailAddress ?? null,
  };
}

export async function startGoogleFlow(
  destinationId: string,
  ownerId: string,
  origin: string,
  transport: GoogleFetch = fetch,
): Promise<{ authorizationUrl: string; cookie: string }> {
  await ownerStillAuthorized(ownerId);
  const connection = await loadConnection(destinationId);
  if (!connection.config.clientId || !connection.config.clientSecret) {
    throw new GoogleConnectionError(
      'Provide your Google Web Application Client ID and Client Secret.',
    );
  }
  const callback = callbackUrl(origin);
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const cookie = randomBytes(32).toString('base64url');
  const relay = connection.config.callbackMode === 'relay';
  if (!relay) validateDirectCallback(callback);
  const redirectUri = relay ? RELAY_CALLBACK : callback;
  const ticketResponse = relay
    ? await transport(`${RELAY_ORIGIN}/api/connect/google-drive/start`, {
        method: 'POST',
        redirect: 'error',
        signal: timeout(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce,
          clientId: connection.config.clientId,
          challenge,
          returnUrl: callback,
        }),
      })
    : null;
  if (ticketResponse && !ticketResponse.ok)
    throw new GoogleConnectionError('The Google callback relay is unavailable.');
  const ticket = ticketResponse
    ? ((await ticketResponse.json()) as {
        ticket: string;
        expiresAt: number;
        redirectUri: string;
      })
    : null;
  if (
    ticket &&
    (typeof ticket.ticket !== 'string' ||
      ticket.ticket.length > 8192 ||
      ticket.redirectUri !== redirectUri ||
      !Number.isFinite(ticket.expiresAt) ||
      ticket.expiresAt <= Date.now())
  ) {
    throw new GoogleConnectionError('The Google callback relay returned invalid routing state.');
  }
  const state = ticket?.ticket ?? nonce;
  const flow: PendingFlow = {
    nonce,
    destinationId,
    ownerId,
    epoch: connection.epoch,
    expiresAt: Math.min(Date.now() + FLOW_TTL, ticket?.expiresAt ?? Infinity),
    state,
    cookieHash: hashCookie(cookie),
    verifier,
    redirectUri,
    callback,
  };
  await savePending(flow);
  const params = new URLSearchParams({
    client_id: connection.config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  const authorizationUrl = relay
    ? `${RELAY_ORIGIN}/connect/google-drive?ngsw-bypass=true#${Buffer.from(
        JSON.stringify({ ticket: state, authorizationUrl: googleUrl }),
      ).toString('base64url')}`
    : googleUrl;
  return { authorizationUrl, cookie };
}

export async function finishGoogleFlow(
  state: string,
  cookie: string,
  code: string | null,
  denied: boolean,
  currentOrigin: string | (() => Promise<string>),
  transport: GoogleFetch = fetch,
): Promise<string> {
  if (
    !state ||
    state.length > 8192 ||
    !/^[A-Za-z0-9_-]{43}$/.test(cookie) ||
    (code !== null && (code.length < 1 || code.length > 4096))
  )
    throw new GoogleConnectionError('Invalid Google callback.');
  const flow = await consumePending(state, hashCookie(cookie));
  await ownerStillAuthorized(flow.ownerId);
  const connection = await loadConnection(flow.destinationId);
  const origin = () =>
    typeof currentOrigin === 'string' ? Promise.resolve(currentOrigin) : currentOrigin();
  if (connection.epoch !== flow.epoch || flow.callback !== callbackUrl(await origin())) {
    throw new GoogleConnectionError('Google configuration or domain changed; start Connect again.');
  }
  if (denied || !code)
    throw new GoogleConnectionError('Google connection was declined; no credentials were saved.');
  const tokens = await tokenRequest(
    new URLSearchParams({
      client_id: connection.config.clientId,
      client_secret: connection.config.clientSecret,
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
      grant_type: 'authorization_code',
    }),
    transport,
  );
  if (!tokens.refreshToken)
    throw new GoogleConnectionError(
      'Google did not grant offline access; reconnect and approve consent.',
    );
  const account = await verifyToken(tokens.accessToken, connection.config.clientId, transport);
  if (connection.config.accountId && connection.config.accountId !== account.accountId) {
    throw new GoogleConnectionError(
      'This destination belongs to another Google account. Create another destination.',
    );
  }
  await ownerStillAuthorized(flow.ownerId);
  if (flow.callback !== callbackUrl(await origin()))
    throw new GoogleConnectionError('Domain changed; reconnect Google Drive.');
  const epoch = await commitTokens(
    flow.destinationId,
    { ...connection.config, ...account, refreshToken: tokens.refreshToken },
    flow.epoch,
  );
  cache.set(flow.destinationId, {
    epoch,
    token: tokens.accessToken,
    expires: Date.now() + tokens.expiresIn * 1000 - 60_000,
  });
  return flow.destinationId;
}

/** Internal machine-to-machine renewal. No public renewal endpoint exists. */
export async function googleAccessToken(
  id: string,
  transport: GoogleFetch = fetch,
): Promise<string> {
  const connection = await loadConnection(id);
  const cached = cache.get(id);
  if (cached && cached.epoch === connection.epoch && cached.expires > Date.now())
    return cached.token;
  if (!connection.config.refreshToken)
    throw new GoogleConnectionError('Reconnect Google Drive to resume backup.');
  const lease = randomBytes(32).toString('base64url');
  if (!(await claimRefresh(id, connection.epoch, lease)))
    throw new GoogleConnectionError('Google token renewal is already in progress; retry shortly.');
  try {
    const tokens = await tokenRequest(
      new URLSearchParams({
        client_id: connection.config.clientId,
        client_secret: connection.config.clientSecret,
        refresh_token: connection.config.refreshToken,
        grant_type: 'refresh_token',
      }),
      transport,
    );
    const account = await verifyToken(tokens.accessToken, connection.config.clientId, transport);
    if (account.accountId !== connection.config.accountId)
      throw new GoogleConnectionError('Google account changed; reconnect.');
    await commitTokens(
      id,
      {
        ...connection.config,
        refreshToken: tokens.refreshToken ?? connection.config.refreshToken,
      },
      connection.epoch,
      lease,
    );
    cache.set(id, {
      epoch: connection.epoch,
      token: tokens.accessToken,
      expires: Date.now() + tokens.expiresIn * 1000 - 60_000,
    });
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof GoogleReconnectRequired) {
      await commitTokens(id, { ...connection.config, refreshToken: null }, connection.epoch, lease);
      cache.delete(id);
    }
    throw error;
  } finally {
    await releaseRefresh(id, lease);
  }
}
