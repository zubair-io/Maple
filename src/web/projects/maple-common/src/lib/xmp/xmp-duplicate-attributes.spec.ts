// #5475: Apple builds before #4686 wrote `papp:FilmLook` twice.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAdjustmentModel } from '../models/adjustment-model';
import { hasXmlParseError, parseSidecarDocument, readSidecar } from './xmp-dom-utils';
import { removeDuplicateAttributes } from './xmp-duplicate-attributes';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const PORTRA = 'color_negative_kodak_portra_160';

const CORRUPT_SIDECAR = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmp:Rating="3"
      crs:Exposure2012="-1.5"
      crs:HasSettings="True"
      crs:ProcessVersion="11.0"
      crs:Temperature="5600"
      crs:Tint="4"
      crs:Version="11.0"
      crs:WhiteBalance="Custom"
      papp:FilmLook="${PORTRA}"
      papp:FilmLook="${PORTRA}"
      papp:Profile="Auto"
      papp:WbScaleVersion="5"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const REPAIRED_SIDECAR = CORRUPT_SIDECAR.replace(`\n      papp:FilmLook="${PORTRA}"`, '');

const occurrences = (xml: string, name: string): number => xml.split(`${name}=`).length - 1;

describe('removeDuplicateAttributes', () => {
  it('drops only the repeated attribute, leaving every other byte in place', () => {
    const repair = removeDuplicateAttributes(CORRUPT_SIDECAR);
    expect(repair?.removed).toEqual(['papp:FilmLook']);
    expect(repair?.xml).toBe(REPAIRED_SIDECAR);
  });

  it('keeps the first value when the copies disagree', () => {
    const xml = '<a x:k="first" y="1" x:k=\'second\' x:k="third"/>';
    expect(removeDuplicateAttributes(xml)?.xml).toBe('<a x:k="first" y="1"/>');
  });

  it('scopes names to one start tag and ignores comments, CDATA and quoted markup', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<!-- <b k="1" k="2"/> -->',
      '<a k="1" v="x > y"><b k="1"><![CDATA[<c k="1" k="2"/>]]></b>',
      '<b k="2" k="3">t &gt; u</b></a>',
    ].join('\n');
    expect(removeDuplicateAttributes(xml)?.xml).toBe(xml.replace(' k="3"', ''));
  });

  it('returns nothing for a document with no repeats or one it cannot tokenize', () => {
    expect(removeDuplicateAttributes('<a k="1"><b k="1"/></a>')).toBeUndefined();
    expect(removeDuplicateAttributes('<!DOCTYPE a><a k="1" k="2"/>')).toBeUndefined();
    expect(removeDuplicateAttributes('<a k="1" k="2"')).toBeUndefined();
    expect(removeDuplicateAttributes('<!-- <a k="1" k="2"/>')).toBeUndefined();
  });
});

describe('a sidecar with a repeated attribute (#5475)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;
  let dir: string;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
    dir = mkdtempSync(join(tmpdir(), 'maple-xmp-5475-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is rejected by the strict parser but parses after the repair', () => {
    expect(hasXmlParseError(new DOMParser().parseFromString(CORRUPT_SIDECAR, 'text/xml'))).toBe(
      true,
    );
    expect(hasXmlParseError(parseSidecarDocument(CORRUPT_SIDECAR))).toBe(false);
    expect(readSidecar(CORRUPT_SIDECAR).xml).toBe(removeDuplicateAttributes(CORRUPT_SIDECAR)?.xml);
    expect(readSidecar(REPAIRED_SIDECAR).xml).toBe(REPAIRED_SIDECAR);
  });

  it('keeps any other malformation an error', () => {
    const unclosed = CORRUPT_SIDECAR.replace('</x:xmpmeta>', '');
    expect(hasXmlParseError(parseSidecarDocument(unclosed))).toBe(true);
    expect(parser.parseAdjustmentModel(unclosed).model).toEqual({});
  });

  it('loads its edits from a real file and the next save writes each attribute once', () => {
    const path = join(dir, '084A9983.xmp');
    writeFileSync(path, CORRUPT_SIDECAR, 'utf8');

    const source = readFileSync(path, 'utf8');
    const { model, passthrough } = parser.parseAdjustmentModel(source);
    const culling = parser.parseCulling(source);
    expect(model.filmLook).toBe(PORTRA);
    expect(model.exposure).toBe(-1.5);
    expect(model.profile).toBe('Auto');
    expect(culling.rating).toBe(3);
    expect(passthrough.unknownAttributes).toEqual([]);

    const saved = serializer.serialize(
      { ...defaultAdjustmentModel(), ...model },
      passthrough,
      culling,
    );
    writeFileSync(path, saved, 'utf8');
    const reread = readFileSync(path, 'utf8');
    expect(occurrences(reread, 'papp:FilmLook')).toBe(1);
    expect(reread).toContain('xmp:Rating="3"');
    expect(hasXmlParseError(new DOMParser().parseFromString(reread, 'text/xml'))).toBe(false);

    const again = parser.parseAdjustmentModel(reread);
    expect(again.model.filmLook).toBe(PORTRA);
    expect(
      serializer.serialize(
        { ...defaultAdjustmentModel(), ...again.model },
        again.passthrough,
        parser.parseCulling(reread),
      ),
    ).toBe(reread);
  });

  it('never writes a name twice, even when passthrough carries an attribute the model owns', () => {
    const xml = serializer.serialize(
      { ...defaultAdjustmentModel(), filmLook: 'slide_fuji_velvia_50' },
      {
        unknownAttributes: [{ name: 'papp:FilmLook', value: PORTRA }],
        unknownNodes: [],
      },
    );
    expect(occurrences(xml, 'papp:FilmLook')).toBe(1);
    expect(xml).toContain('papp:FilmLook="slide_fuji_velvia_50"');
    expect(hasXmlParseError(new DOMParser().parseFromString(xml, 'text/xml'))).toBe(false);
  });
});
