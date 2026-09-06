import {
  TRANSFER_XMP_ATTRIBUTES,
  TRANSFER_XMP_ELEMENTS,
} from '../../generated/adjustment-transfer.generated';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { camelToSnakeField } from '../presets/preset-model';

export interface XmpTransferPatch {
  attributes: Record<string, string | null>;
  elements: Record<string, string | null>;
}

const NAMESPACES: Readonly<Record<string, string>> = {
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  papp: 'http://ns.justmaple.app/photo/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

/** Take selected values from the real serializer, including its default omissions.
 * The server receives only selected tokens, never a replacement sidecar. */
export function buildXmpTransferPatch(
  patch: Partial<AdjustmentModel>,
  serialized: string,
): XmpTransferPatch {
  const doc = new DOMParser().parseFromString(serialized, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not serialize the copied settings');
  const description = doc.getElementsByTagNameNS(NAMESPACES['rdf'], 'Description')[0];
  if (!description) throw new Error('The copied settings have no RDF description');
  const attributes: Record<string, string | null> = {};
  const elements: Record<string, string | null> = {};
  const readAttribute = (key: string): void => {
    const [prefix, local] = key.split(':');
    attributes[key] = description.getAttributeNS(NAMESPACES[prefix], local);
  };
  for (const field of Object.keys(patch)) {
    const canonical = camelToSnakeField(field);
    for (const key of TRANSFER_XMP_ATTRIBUTES[canonical] ?? []) readAttribute(key);
    const key = TRANSFER_XMP_ELEMENTS[canonical];
    if (!key) continue;
    const [prefix, local] = key.split(':');
    const node = [...description.children].find(
      (child) => child.namespaceURI === NAMESPACES[prefix] && child.localName === local,
    );
    if (!node) {
      elements[key] = null;
      continue;
    }
    const clone = node.cloneNode(true) as Element;
    for (const [ns, uri] of Object.entries(NAMESPACES))
      clone.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${ns}`, uri);
    elements[key] = new XMLSerializer().serializeToString(clone);
  }
  if (Object.hasOwn(patch, 'whiteBalancePreset')) {
    readAttribute('crs:WhiteBalance');
    readAttribute('papp:WbScaleVersion');
    for (const key of ['papp:WbSampleX', 'papp:WbSampleY', 'papp:WbAlgorithmVersion'])
      attributes[key] = null;
  }
  return { attributes, elements };
}
