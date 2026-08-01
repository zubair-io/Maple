import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(webRoot, '..');
const appleIcons = resolve(srcRoot, 'apple/Maple/Assets.xcassets/AppIcon.appiconset');
const appleLaunch = resolve(srcRoot, 'apple/Maple/Assets.xcassets/LaunchLogo.imageset');
const brandRoot = resolve(webRoot, 'projects/maple-common/src/assets/brand');
const checkOnly = process.argv.includes('--check');
const REVIEWED_APP_ICON_HASH = 'b03b2f446f9d9ec625bb91197b9725565a7b51ecb032ea421a1fade1c5adba6d';
const REQUIRED_BRAND_ASSETS = [
  'favicon.ico',
  'icon-192.png',
  'icon-512-maskable.png',
  'icon-512.png',
  'maple-mark.png',
];

const copiedAssets = [
  [resolve(appleIcons, 'maple512.png'), resolve(brandRoot, 'icon-512.png')],
  [resolve(appleLaunch, 'launchlogo_2x.png'), resolve(brandRoot, 'maple-mark.png')],
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function syncCopy(source, destination) {
  const sourceBytes = await readFile(source);
  if (checkOnly) {
    const destinationBytes = await readFile(destination);
    assert(
      sourceBytes.equals(destinationBytes),
      `${destination} differs from Apple source ${source}`,
    );
    return;
  }
  await copyFile(source, destination);
}

function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach(({ size, bytes }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ bytes }) => bytes)]);
}

async function generatedFavicon() {
  const sizes = [16, 32, 64, 128, 256];
  const images = await Promise.all(
    sizes.map(async (size) => ({
      size,
      bytes: await readFile(resolve(appleIcons, `maple${size}.png`)),
    })),
  );
  return icoFromPngs(images);
}

async function syncFavicon() {
  const destination = resolve(brandRoot, 'favicon.ico');
  const expected = await generatedFavicon();
  if (checkOnly) {
    assert(
      expected.equals(await readFile(destination)),
      `${destination} is not Apple-icon derived`,
    );
    return;
  }
  await writeFile(destination, expected);
}

async function checkPinnedDerivative(name, width, expectedHash) {
  const path = resolve(brandRoot, name);
  const bytes = await readFile(path);
  assert(bytes.toString('ascii', 12, 16) === 'IHDR', `${path} is not a PNG`);
  assert(bytes.readUInt32BE(16) === width, `${path} width must be ${width}`);
  assert(bytes.readUInt32BE(20) === width, `${path} height must be ${width}`);
  assert(
    sha256(bytes) === expectedHash,
    `${path} changed; regenerate it from the Apple 512px icon`,
  );
}

async function checkConsumers() {
  for (const app of ['maple', 'maple-syrup']) {
    const appRoot = resolve(webRoot, `projects/${app}`);
    const manifest = JSON.parse(
      await readFile(resolve(appRoot, 'src/manifest.webmanifest'), 'utf8'),
    );
    const sources = manifest.icons.map(({ src }) => src);
    for (const expected of [
      'assets/brand/icon-192.png',
      'assets/brand/icon-512.png',
      'assets/brand/icon-512-maskable.png',
    ]) {
      assert(sources.includes(expected), `${app} manifest does not reference ${expected}`);
    }
    const index = await readFile(resolve(appRoot, 'src/index.html'), 'utf8');
    assert(index.includes('assets/brand/maple-mark.png'), `${app} boot splash is not shared`);
    assert(index.includes('assets/brand/icon-192.png'), `${app} touch icon is not shared`);
    assert(!/fonts\.(?:googleapis|gstatic)\.com/.test(index), `${app} still loads a Google font`);
    assert(!existsSync(resolve(appRoot, 'src/assets')), `${app} still has duplicated app assets`);
    assert(
      !existsSync(resolve(appRoot, 'public/favicon.ico')),
      `${app} still has a duplicated favicon`,
    );
  }

  const landing = await readFile(
    resolve(webRoot, 'projects/maple-syrup/src/app/landing/landing.component.html'),
    'utf8',
  );
  assert(
    landing.includes('assets/brand/maple-mark.png'),
    'Hosted welcome does not use shared mark',
  );
}

if (checkOnly) {
  const missingAssets = REQUIRED_BRAND_ASSETS.filter(
    (asset) => !existsSync(resolve(brandRoot, asset)),
  );
  assert(
    missingAssets.length === 0,
    `missing brand assets: ${missingAssets.join(', ')}; run \`bun run brand:sync\``,
  );
} else {
  await mkdir(brandRoot, { recursive: true });
}
assert(
  sha256(await readFile(resolve(appleIcons, 'maple512.png'))) === REVIEWED_APP_ICON_HASH,
  'Apple maple512.png changed; regenerate and review the 192px and maskable derivatives',
);
for (const [source, destination] of copiedAssets) await syncCopy(source, destination);
await syncFavicon();

// These two platform derivatives need resampling/compositing. Pin their
// reviewed outputs while the exact Apple originals above remain byte-equal.
await checkPinnedDerivative(
  'icon-192.png',
  192,
  '4b4115da7119b595c8159865a6ef24dd71f5608b5e80fc945b586ac3dfb600ff',
);
await checkPinnedDerivative(
  'icon-512-maskable.png',
  512,
  '266578664a5b08942f47bb95b369c0a8057c795eb97e5d51114d372921ea2a05',
);
await checkConsumers();
console.log(`Brand assets ${checkOnly ? 'match' : 'synced from'} Apple resources.`);
