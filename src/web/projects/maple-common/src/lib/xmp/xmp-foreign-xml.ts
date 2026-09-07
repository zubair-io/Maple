/** Serialize a foreign subtree with every namespace it inherited made explicit. */
const usedPrefix = (attribute: Attr): string | null =>
  attribute.prefix && attribute.prefix !== 'xmlns' && attribute.namespaceURI
    ? attribute.prefix
    : null;

const elementPrefixes = (element: Element): string[] =>
  [
    element.namespaceURI ? (element.prefix ?? '') : null,
    ...Array.from(element.attributes, usedPrefix),
  ].filter((prefix): prefix is string => prefix !== null);

const inScopeNamespaces = (source: Element): ReadonlyMap<string, string> => {
  const prefixes = new Set([source, ...source.querySelectorAll('*')].flatMap(elementPrefixes));
  return new Map(
    Array.from(prefixes).flatMap((prefix) => {
      const uri = source.lookupNamespaceURI(prefix || null);
      return uri ? [[prefix, uri]] : [];
    }),
  );
};

const addExplicitNamespaces = (element: Element, namespaces: ReadonlyMap<string, string>): void => {
  for (const [prefix, uri] of namespaces) {
    if (prefix === 'xml') continue;
    const name = prefix ? `xmlns:${prefix}` : 'xmlns';
    if (!element.hasAttribute(name)) {
      element.setAttributeNS('http://www.w3.org/2000/xmlns/', name, uri);
    }
  }
};

export const selfContainedXml = (source: Element): string => {
  const clone = source.cloneNode(true) as Element;
  addExplicitNamespaces(clone, inScopeNamespaces(source));
  return clone.outerHTML;
};
