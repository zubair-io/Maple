import { describe, expect, it } from 'bun:test';
import { parseFolderCulling } from './folder-culling.ts';

const document = (inner: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ` +
  `xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/">${inner}</rdf:RDF></x:xmpmeta>`;

describe('parseFolderCulling', () => {
  it('merges the attributes of descriptions about the same subject, first value winning', () => {
    const parsed = parseFolderCulling(
      document(
        '<rdf:Description rdf:about="" xmp:Rating="3"/>' +
          '<rdf:Description rdf:about="" xmp:Rating="5" xmp:Label="Red" papp:Flag="pick"/>',
      ),
    );
    expect(parsed).toMatchObject({ rating: 3, flag: 'pick', colorLabel: 'red' });
  });

  it('prefers the subject-less description with the most content over a named one', () => {
    const parsed = parseFolderCulling(
      document(
        '<rdf:Description rdf:about="other" xmp:Rating="1"/>' +
          '<rdf:Description rdf:about="" xmp:Rating="4"><a/><b/></rdf:Description>',
      ),
    );
    expect(parsed.rating).toBe(4);
  });

  it('ignores descriptions nested inside another description or inside a nested RDF', () => {
    const nested = parseFolderCulling(
      document(
        '<rdf:Description rdf:about="" papp:Flag="reject"><papp:Data><rdf:Description xmp:Rating="5"/></papp:Data></rdf:Description>',
      ),
    );
    expect(nested).toMatchObject({ flag: 'reject' });
    expect(nested.rating).toBeUndefined();
    const nestedRdf = parseFolderCulling(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
        '<rdf:Description xmp:Rating="2"/><rdf:RDF><rdf:Description xmp:Rating="5"/></rdf:RDF></rdf:RDF></x:xmpmeta>',
    );
    expect(nestedRdf.rating).toBe(2);
  });

  it('finds an RDF wrapper at any depth below non-RDF elements', () => {
    const parsed = parseFolderCulling(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><x:inner><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
        '<rdf:Description xmp:Rating="4"/></rdf:RDF></x:inner></x:xmpmeta>',
    );
    expect(parsed.rating).toBe(4);
  });

  it('falls back to the tolerant reader for a fragment that is not well-formed or has a DOCTYPE', () => {
    expect(parseFolderCulling(document('<rdf:Description xmp:Rating="3">'))).toBeDefined();
    const withDoctype = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "v">]>${document('<rdf:Description xmp:Rating="3"/>')}`;
    expect(() => parseFolderCulling(withDoctype)).not.toThrow();
  });

  it('rejects an out-of-range rating and an unknown flag', () => {
    const parsed = parseFolderCulling(
      document('<rdf:Description xmp:Rating="9" papp:Flag="maybe"/>'),
    );
    expect(parsed.rating).toBeUndefined();
    expect(parsed.flag).toBeUndefined();
  });
});
