#!/usr/bin/env bun
/** GitHub push webhook → maple-deploy.service (#4450). Runs on the host, not in the API container,
 * because the deploy it triggers stops and replaces that container. See ../maple-deploy-webhook.service. */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEPLOY_REF = 'refs/heads/main';
const DEFAULT_PORT = 9871;
// GitHub caps webhook payloads at 25 MB.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function signatureMatches(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function pushedRef(body: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(body);
    return typeof payload === 'object' &&
      payload !== null &&
      'ref' in payload &&
      typeof payload.ref === 'string'
      ? payload.ref
      : undefined;
  } catch {
    return undefined;
  }
}

export async function handleDeployWebhook(
  request: Request,
  secret: string,
  triggerDeploy: () => Promise<void>,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed\n', { status: 405 });
  const body = await request.text();
  if (!signatureMatches(secret, body, request.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature\n', { status: 401 });
  }
  const event = request.headers.get('x-github-event');
  if (event === 'ping') return new Response('pong\n');
  if (event !== 'push') return new Response(`ignored event ${event}\n`, { status: 202 });
  const ref = pushedRef(body);
  if (ref !== DEPLOY_REF) return new Response(`ignored ref ${ref}\n`, { status: 202 });
  await triggerDeploy();
  return new Response('deploy triggered\n', { status: 202 });
}

async function startDeployService(): Promise<void> {
  // --no-block: the deploy runs for tens of minutes; GitHub times a delivery out after 10s.
  const proc = Bun.spawn(['systemctl', 'start', '--no-block', 'maple-deploy.service'], {
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`systemctl start maple-deploy.service exited ${code}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see maple-deploy-webhook.service)`);
  return value;
}

if (import.meta.main) {
  const secret = requireEnv('MAPLE_DEPLOY_WEBHOOK_SECRET');
  const hostname = requireEnv('MAPLE_DEPLOY_WEBHOOK_HOST');
  const port = Number(process.env.MAPLE_DEPLOY_WEBHOOK_PORT ?? DEFAULT_PORT);
  const server = Bun.serve({
    hostname,
    port,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: async (request) => {
      try {
        const response = await handleDeployWebhook(request, secret, startDeployService);
        console.log(
          `${request.method} ${new URL(request.url).pathname} ${request.headers.get('x-github-event')} -> ${response.status}`,
        );
        return response;
      } catch (error) {
        console.error(error);
        return new Response('deploy trigger failed\n', { status: 500 });
      }
    },
  });
  console.log(`deploy webhook listening on ${server.hostname}:${server.port}`);
}
