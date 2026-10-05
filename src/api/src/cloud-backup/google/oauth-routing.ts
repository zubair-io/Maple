import { GoogleConnectionError, RELAY_CALLBACK, RELAY_ORIGIN } from './config.ts';
import type { GoogleFetch } from './oauth.ts';

interface RelayTicket {
  ticket: string;
  expiresAt: number;
  redirectUri: string;
}
/** This request sends only routing metadata to the fixed relay, excluding PKCE verifiers and tokens. */
export async function relayTicket(
  routing: { nonce: string; clientId: string; challenge: string; returnUrl: string },
  transport: GoogleFetch,
): Promise<RelayTicket> {
  const response = await transport(`${RELAY_ORIGIN}/api/connect/google-drive/start`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(routing),
  });
  if (!response.ok) throw new GoogleConnectionError('The Google callback relay is unavailable.');
  const ticket = (await response.json()) as RelayTicket;
  if (
    !ticket ||
    typeof ticket.ticket !== 'string' ||
    !ticket.ticket.length ||
    ticket.ticket.length > 8192 ||
    ticket.redirectUri !== RELAY_CALLBACK ||
    !Number.isFinite(ticket.expiresAt) ||
    ticket.expiresAt <= Date.now()
  )
    throw new GoogleConnectionError('The Google callback relay returned invalid routing state.');
  return ticket;
}
