// Foreign AI corrections cannot be regenerated from Maple's bitmap recipe.
// Keep their XML in place while replacing only corrections the model owns.
// Templates are compiled once on read; saving never reparses foreign XML.
import type { AdjustmentModel, LocalAdjustment } from '../models/adjustment-model';
import type { MaskGroupTemplate, PassthroughBucket } from './xmp.types';
import { managedXmpName } from './xmp-dom-utils';
import { selfContainedXml } from './xmp-foreign-xml';
import {
  localAdjustmentBlocks,
  localAdjustmentContainerKind,
  localCorrectionBlock,
  parseLocalCorrection,
} from './xmp-local-adjustments';

const childrenNamed = (element: Element, name: string): Element[] =>
  Array.from(element.children).filter((child) => managedXmpName(child) === name);

/** Composite/foreign masks stay opaque: selecting the first recognized leaf
 * would discard the rest of the mask, and could apply a different selection. */
function modeledCorrection(item: Element): LocalAdjustment | undefined {
  if (managedXmpName(item) !== 'rdf:li' || item.children.length !== 1) return undefined;
  const description = childrenNamed(item, 'rdf:Description')[0];
  if (!description) return undefined;
  const masks = childrenNamed(description, 'crs:CorrectionMasks');
  const sequences = masks.length === 1 ? childrenNamed(masks[0], 'rdf:Seq') : [];
  if (sequences.length !== 1 || sequences[0].children.length !== 1) return undefined;
  return parseLocalCorrection(description, 'group');
}

type TemplatePart = MaskGroupTemplate['parts'][number];

function templateParts(
  root: Element,
  slots: ReadonlyMap<Node, number>,
  tail: Node,
): TemplatePart[] {
  // Serialize the whole subtree once so namespace prefixes stay in their
  // original context. A collision-free comment marks each owned slot.
  let marker = 'maple-mask-slot';
  while (root.outerHTML.includes(marker)) marker += 'x';
  for (const [node, index] of slots) {
    node.parentNode!.replaceChild(root.ownerDocument.createComment(`${marker}${index}`), node);
  }
  tail.appendChild(root.ownerDocument.createComment(`${marker}append`));
  const [first, ...rest] = root.outerHTML.split(`<!--${marker}`);
  return [
    first,
    ...rest.flatMap((part): TemplatePart[] => {
      const end = part.indexOf('-->');
      const slot = part.slice(0, end);
      return [slot === 'append' ? null : Number(slot), part.slice(end + 3)];
    }),
  ];
}

/** Make inherited namespaces explicit, including the prefixes used by newly
 * added Maple layers, so adding a layer does not churn the next save. */
function groupClone(group: Element): Element {
  const clone = new DOMParser().parseFromString(
    selfContainedXml(group),
    'text/xml',
  ).documentElement;
  for (const [prefix, uri] of Object.entries({
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
    papp: 'http://ns.justmaple.app/photo/1.0/',
  })) {
    if (!clone.hasAttribute(`xmlns:${prefix}`))
      clone.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  }
  return clone;
}

function collectGroup(
  group: Element,
  layers: LocalAdjustment[],
): { template: MaskGroupTemplate; opaque: boolean } {
  const clone = groupClone(group);
  const seqs = childrenNamed(clone, 'rdf:Seq');
  const seq = seqs.length === 1 ? seqs[0] : undefined;
  const slots = new Map<Node, number>();
  let opaque =
    !seq ||
    hasForeignWrapperData(clone, seq) ||
    Array.from(seq.attributes).some(
      (attr) => attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/',
    );
  for (const item of Array.from(seq?.children ?? [])) {
    const layer = modeledCorrection(item);
    if (layer) {
      slots.set(item, layers.length);
      layers.push(layer);
    } else opaque = true;
  }
  return {
    template: { parts: seq ? templateParts(clone, slots, seq) : [clone.outerHTML] },
    opaque,
  };
}

/** Moving a group must retain its RDF subject and inherited XML context. */
export function sharesMaskGroupContext(description: Element, primary: Element): boolean {
  return [
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about'],
    ['http://www.w3.org/XML/1998/namespace', 'lang'],
    ['http://www.w3.org/XML/1998/namespace', 'base'],
  ].every(
    ([namespace, name]) =>
      (description.getAttributeNS(namespace, name) ?? '') ===
      (primary.getAttributeNS(namespace, name) ?? ''),
  );
}

const hasForeignWrapperData = (element: Element, managedChild: Element | undefined): boolean =>
  Array.from(element.attributes).some(
    (attr) => attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/',
  ) ||
  Array.from(element.childNodes).some(
    (node) =>
      node !== managedChild && (node.nodeType !== Node.TEXT_NODE || !!node.textContent?.trim()),
  );

/** Only direct descriptions in the same RDF are moved: other RDF subtrees
 * are already preserved whole by the ordinary passthrough buckets. */
export function collectMaskGroups(
  primary: Element,
  model: Partial<AdjustmentModel>,
): Pick<PassthroughBucket, 'maskGroups'> {
  const descriptions = primary.parentElement
    ? childrenNamed(primary.parentElement, 'rdf:Description')
    : [primary];
  const groups = descriptions
    .filter((description) => sharesMaskGroupContext(description, primary))
    .flatMap((description) =>
      Array.from(description.children).filter(
        (child) => localAdjustmentContainerKind(child) === 'group',
      ),
    );
  const layers: LocalAdjustment[] = [];
  const collected = groups.map((group) => collectGroup(group, layers));
  const opaque = collected.some((group) => group.opaque);
  // Stable host-only identities survive spreads/undo clones. Array indices
  // alone would move a surviving layer across a foreign pin on deletion.
  if (opaque)
    layers.forEach((layer, index) => {
      layer.xmpGroupSlot = index;
    });
  if (groups.length) model.localAdjustments = [...(model.localAdjustments ?? []), ...layers];
  return opaque ? { maskGroups: { templates: collected.map((group) => group.template) } } : {};
}

const isGroup = (layer: LocalAdjustment): boolean =>
  layer.mask.kind === 'bitmap' || layer.mask.kind === 'everywhere';

/** New canonical entries need their own namespaces: a foreign container may
 * legitimately rebind the conventional rdf/crs/papp prefixes. */
function scopedCorrection(layer: LocalAdjustment): string {
  return localCorrectionBlock(layer, '').replace(
    '<rdf:li>',
    '<rdf:li xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"' +
      ' xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"' +
      ' xmlns:papp="http://ns.justmaple.app/photo/1.0/">',
  );
}

/** Retain opaque correction order and container metadata; replace each owned
 * slot from the current model, omit deleted slots, append newly added layers. */
export function localAdjustmentBlocksWithPassthrough(
  model: Partial<AdjustmentModel>,
  indent: string,
  preserved: PassthroughBucket['maskGroups'],
): string {
  if (!preserved) return localAdjustmentBlocks(model, indent);
  const layers = model.localAdjustments ?? [];
  const groupLayers = layers.filter(isGroup);
  const groups = new Map(
    groupLayers
      .filter((layer) => layer.xmpGroupSlot !== undefined)
      .map((layer) => [layer.xmpGroupSlot, scopedCorrection(layer)]),
  );
  const appended = groupLayers
    .filter((layer) => layer.xmpGroupSlot === undefined)
    .map(scopedCorrection)
    .join('');
  const lastAppend = preserved.templates
    .map((template) => template.parts.includes(null))
    .lastIndexOf(true);
  const blocks = preserved.templates.map(
    (template, index) =>
      indent +
      template.parts
        .map((part) => {
          if (part === null) return index === lastAppend ? appended : '';
          return typeof part === 'number' ? (groups.get(part) ?? '') : part;
        })
        .join(''),
  );
  const newGroups = lastAppend < 0 ? layers.filter(isGroup) : [];
  return [
    localAdjustmentBlocks(
      { localAdjustments: [...layers.filter((layer) => !isGroup(layer)), ...newGroups] },
      indent,
    ),
    ...blocks,
  ]
    .filter(Boolean)
    .join('\n');
}
