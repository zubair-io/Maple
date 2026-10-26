import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

const CAMERA_NS = 'http://ns.google.com/photos/1.0/camera/';
const CONTAINER_NS = 'http://ns.google.com/photos/1.0/container/';
const ITEM_NS = 'http://ns.google.com/photos/1.0/container/item/';
const CAMERA_FIELDS = new Set([
  'MotionPhoto',
  'MotionPhotoVersion',
  'MotionPhotoPresentationTimestampUs',
  'MicroVideo',
  'MicroVideoVersion',
  'MicroVideoOffset',
]);
const ITEM_FIELDS = new Set(['Mime', 'Semantic', 'Length', 'Padding']);
const MAX_ITEMS = 64;

export type CameraField =
  | 'MotionPhoto'
  | 'MotionPhotoVersion'
  | 'MotionPhotoPresentationTimestampUs'
  | 'MicroVideo'
  | 'MicroVideoVersion'
  | 'MicroVideoOffset';

export type ItemField = 'Mime' | 'Semantic' | 'Length' | 'Padding';

/** The Google camera and Container vocabulary of one XMP packet, as raw strings. */
export interface MotionXmp {
  camera: ReadonlyMap<CameraField, string>;
  directories: number;
  items: ReadonlyArray<ReadonlyMap<ItemField, string>>;
}

interface OpenElement {
  uri: string;
  local: string;
  text: string;
  hasChildren: boolean;
}

class MalformedXmp extends Error {}

function assign<K>(map: Map<K, string>, key: K, value: string): void {
  if (map.has(key)) throw new MalformedXmp(`duplicate ${String(key)}`);
  map.set(key, value);
}

function withoutTrailingNuls(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0) end -= 1;
  return text.slice(0, end);
}

/**
 * Collect the Motion Photo fields of an XMP packet, in attribute or element
 * form, with their namespaces resolved rather than matched on prefix. Returns
 * null for a packet that is not well-formed XML, declares a DTD, repeats a
 * field, or lists more than 64 Container items.
 */
// fallow-ignore-next-line complexity
export function parseMotionXmp(xmp: string): MotionXmp | null {
  const camera = new Map<CameraField, string>();
  const items: Map<ItemField, string>[] = [];
  const stack: OpenElement[] = [];
  const state = { directories: 0, directoryDepth: -1, itemDepth: -1 };
  const parser = new SaxesParser({ xmlns: true });

  parser.on('doctype', () => {
    throw new MalformedXmp('DTD');
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    const parent = stack.at(-1);
    if (parent) parent.hasChildren = true;
    const depth = stack.length;
    for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
      if (attribute.uri === CAMERA_NS && CAMERA_FIELDS.has(attribute.local)) {
        assign(camera, attribute.local as CameraField, attribute.value);
      }
    }
    if (tag.uri === CONTAINER_NS && tag.local === 'Directory') {
      state.directories += 1;
      state.directoryDepth = depth;
    }
    if (tag.uri === CONTAINER_NS && tag.local === 'Item' && state.directoryDepth >= 0) {
      if (items.length >= MAX_ITEMS) throw new MalformedXmp('too many items');
      const item = new Map<ItemField, string>();
      for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
        if (attribute.uri === ITEM_NS && ITEM_FIELDS.has(attribute.local)) {
          assign(item, attribute.local as ItemField, attribute.value);
        }
      }
      items.push(item);
      state.itemDepth = depth;
    }
    stack.push({
      uri: tag.uri,
      local: tag.local,
      text: '',
      hasChildren: false,
    });
  });
  parser.on('text', (text) => {
    const top = stack.at(-1);
    if (top) top.text += text;
  });
  parser.on('closetag', () => {
    const element = stack.pop();
    const depth = stack.length;
    if (!element) return;
    const value = element.text.trim();
    if (!element.hasChildren && element.uri === CAMERA_NS && CAMERA_FIELDS.has(element.local)) {
      assign(camera, element.local as CameraField, value);
    }
    if (
      !element.hasChildren &&
      state.itemDepth >= 0 &&
      element.uri === ITEM_NS &&
      ITEM_FIELDS.has(element.local)
    ) {
      assign(items.at(-1)!, element.local as ItemField, value);
    }
    if (depth === state.itemDepth) state.itemDepth = -1;
    if (depth === state.directoryDepth) state.directoryDepth = -1;
  });

  try {
    parser.write(withoutTrailingNuls(xmp)).close();
  } catch {
    return null;
  }
  return { camera, directories: state.directories, items };
}

/** A strict base-10 integer, or null. Rejects signs where `unsigned`, blanks, and unsafe values. */
export function integerField(raw: string | undefined, unsigned: boolean): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  const pattern = unsigned ? /^\d+$/ : /^-?\d+$/;
  if (!pattern.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
