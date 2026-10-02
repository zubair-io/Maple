// #3984: real dev shell + real isolated Self Hosted API/SQLite/native workers.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const web = resolve(import.meta.dir, '..');
const runtime = resolve(web, 'test-results/removal-self-hosted-runtime.json');
const root = await mkdtemp(join(tmpdir(), 'maple-removal-self-hosted-'));
const children: Bun.Subprocess[] = [];
let stopping: Promise<never> | undefined;

async function stop(code: number): Promise<never> {
  stopping ??= (async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    const all = Promise.allSettled(children.map((child) => child.exited));
    if (await Promise.race([all.then(() => false), Bun.sleep(5000).then(() => true)])) {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      await all;
    }
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { force: true });
    process.exit(code);
  })();
  return stopping;
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

async function ready(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness: ${url}`);
    if (
      await fetch(url, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  await mkdir(resolve(web, 'test-results'), { recursive: true });
  const proxy = join(root, 'proxy.json');
  await writeFile(
    proxy,
    JSON.stringify({
      '/api': {
        target: 'http://127.0.0.1:4204',
        secure: false,
        changeOrigin: true,
        ws: true,
      },
    }),
  );
  await writeFile(runtime, JSON.stringify({ root }));
  const api = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: resolve(web, '../api'),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT: '4204',
      MAPLE_DEV_AUTH: '1',
      MAPLE_DEV: '0',
      MAPLE_ROOTS: root,
      MAPLE_SQLITE_PATH: join(root, 'runtime.sqlite'),
      MAPLE_JWT_SECRET_FILE: join(root, 'jwt.secret'),
      MAPLE_BACKUP_TMP: join(root, 'backup'),
      MAPLE_INDEXER_AUTOSTART: '0',
    },
  });
  children.push(api);
  await ready('http://127.0.0.1:4204/api/health', api);
  const shell = Bun.spawn(
    [
      'bun',
      'x',
      'ng',
      'serve',
      'maple',
      '--host',
      '127.0.0.1',
      '--port',
      '4203',
      '--proxy-config',
      proxy,
    ],
    {
      cwd: web,
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env,
    },
  );
  children.push(shell);
  await ready('http://127.0.0.1:4203', shell);
  console.log(`Isolated Self Hosted removal dev server ready; fixture root ${root}`);
  await Promise.race(children.map((child) => child.exited));
  await stop(1);
} catch (error) {
  console.error(error);
  await stop(1);
}
