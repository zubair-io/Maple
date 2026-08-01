import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { LibraryStateService } from '../state/library-state.service';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { assertValidSingleFileXmp, SingleFileXmpService } from './single-file-xmp.service';
import { XmpStoreService } from './xmp-store.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { XmpParserService } from './xmp-parser.service';

const sidecar = (attributes = '') => `
  <x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about="" ${attributes} />
    </rdf:RDF>
  </x:xmpmeta>`;

describe('SingleFileXmpService', () => {
  let library: LibraryStateService;
  let durability: SingleFileXmpService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    durability = TestBed.inject(SingleFileXmpService);
  });

  it('hydrates a paired XMP as durable and preserves unknown XML', () => {
    const xmp = sidecar(`
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:vendor="https://example.test/vendor"
      crs:Exposure2012="1.25" xmp:Rating="4" vendor:Recipe="keep"`);
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );

    expect(library.adjustmentFor(id)().exposure).toBe(1.25);
    expect(library.focusedAsset()?.rating).toBe(4);
    expect(TestBed.inject(XmpStoreService).passthroughFor(id)?.unknownAttributes).toContainEqual({
      name: 'vendor:Recipe',
      value: 'keep',
    });
    expect(durability.status()).toEqual({ assetId: id, durability: 'paired', unsaved: false });
  });

  it('marks later edits unsaved and a download durable again', () => {
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      sidecar(),
    );

    library.updateAdjustment(id, { exposure: 0.5 });
    expect(durability.status()).toEqual({ assetId: id, durability: 'paired', unsaved: true });

    durability.markDownloaded(id);
    expect(durability.status()).toEqual({ assetId: id, durability: 'downloaded', unsaved: false });

    library.updateAdjustment(id, { exposure: 0.75 });
    expect(durability.status()).toEqual({ assetId: id, durability: 'downloaded', unsaved: true });
  });

  it('rejects malformed XMP before replacing the active session', () => {
    library.enterSingleFileWorkspace(new Uint8Array([9]), 'existing.dng', 'existing-id');

    expect(() =>
      library.enterSingleFileWorkspace(
        new Uint8Array([1]),
        'photo.dng',
        'photo-id',
        false,
        '<not-xmp/>',
      ),
    ).toThrow('not a valid sidecar');
    expect(library.focusedAsset()).toEqual(
      expect.objectContaining({ id: 'existing-id', filename: 'existing.dng' }),
    );
    expect(library.assets().some((asset) => asset.id === 'photo-id')).toBe(false);
  });

  it('rejects parser-error documents even when they contain apparent RDF content', () => {
    const parserFailure = `
      <parsererror xmlns="http://www.mozilla.org/newlayout/xml/parsererror.xml">
        malformed input
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description />
        </rdf:RDF>
      </parsererror>`;

    expect(() => assertValidSingleFileXmp(parserFailure)).toThrow('not a valid sidecar');
    expect(() =>
      assertValidSingleFileXmp(`
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description />
          </rdf:RDF>
        </broken>`),
    ).toThrow('not a valid sidecar');
  });

  it('accepts and preserves a valid foreign parsererror element', () => {
    const vendorUri = 'https://vendor.test/diagnostics';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:vendor="${vendorUri}">
            <vendor:parsererror vendor:Code="camera-note">Keep this metadata</vendor:parsererror>
          </rdf:Description>
        </rdf:RDF>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      TestBed.inject(XmpStoreService).passthroughFor(id),
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');
    const vendorError = document.getElementsByTagNameNS(vendorUri, 'parsererror')[0];

    expect(vendorError?.getAttributeNS(vendorUri, 'Code')).toBe('camera-note');
    expect(vendorError?.textContent).toBe('Keep this metadata');
  });

  it('resolves RDF and managed fields by namespace URI instead of source prefix', () => {
    const xmp = `
      <meta:xmpmeta xmlns:meta="adobe:ns:meta/">
        <graph:RDF xmlns:graph="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <graph:Description
            xmlns:develop="http://ns.adobe.com/camera-raw-settings/1.0/"
            develop:Exposure2012="1.75" />
        </graph:RDF>
      </meta:xmpmeta>`;

    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );

    expect(library.adjustmentFor(id)().exposure).toBe(1.75);
  });

  it('preserves a wrong-URI prefix collision without treating it as a managed field', () => {
    const foreignUri = 'https://vendor.test/not-camera-raw';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:crs="${foreignUri}" crs:Exposure2012="99" />
        </rdf:RDF>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );
    const passthrough = TestBed.inject(XmpStoreService).passthroughFor(id);
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      passthrough,
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');

    expect(library.adjustmentFor(id)().exposure).toBe(0);
    const description = document.getElementsByTagNameNS(
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      'Description',
    )[0];
    expect(description.getAttributeNS(foreignUri, 'Exposure2012')).toBe('99');
    expect(
      description.getAttributeNS('http://ns.adobe.com/camera-raw-settings/1.0/', 'Exposure2012'),
    ).toBeNull();
  });

  it('round-trips foreign metadata across RDF and xmpmeta sibling structures', () => {
    const vendorUri = 'https://vendor.test/workflow';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:v="${vendorUri}">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about="#foreign" v:Recipe="keep">
            <v:Stack><v:Step>one</v:Step></v:Stack>
          </rdf:Description>
          <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:Exposure2012="1" />
          <v:Catalog v:Version="2" />
        </rdf:RDF>
        <v:DocumentPolicy>retain</v:DocumentPolicy>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );
    library.updateAdjustment(id, { exposure: 2 });
    const asset = library.focusedAsset()!;
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      TestBed.inject(XmpStoreService).passthroughFor(id),
      { rating: asset.rating, flag: asset.flag, colorLabel: asset.colorLabel },
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');

    expect(document.querySelector('parseerror')).toBeNull();
    expect(document.getElementsByTagNameNS(vendorUri, 'Stack')).toHaveLength(1);
    expect(document.getElementsByTagNameNS(vendorUri, 'Step')[0]?.textContent).toBe('one');
    expect(document.getElementsByTagNameNS(vendorUri, 'Catalog')).toHaveLength(1);
    expect(document.getElementsByTagNameNS(vendorUri, 'DocumentPolicy')[0]?.textContent).toBe(
      'retain',
    );
    const foreignDescription = Array.from(
      document.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description'),
    ).find((description) => description.getAttributeNS(vendorUri, 'Recipe') === 'keep');
    expect(foreignDescription).toBeDefined();
    expect(library.adjustmentFor(id)().exposure).toBe(2);
  });

  it('merges modeled sibling fields with first-occurrence precedence and removes stale copies', () => {
    const vendorUri = 'https://vendor.test/sibling';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:v="${vendorUri}">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
          xmlns:xmp="http://ns.adobe.com/xap/1.0/">
          <rdf:Description crs:Exposure2012="1" v:First="keep" />
          <rdf:Description crs:Exposure2012="9" crs:Vibrance="22"
            xmp:Rating="4" v:Second="keep-too" />
        </rdf:RDF>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );

    expect(library.adjustmentFor(id)()).toMatchObject({ exposure: 1, vibrance: 22 });
    expect(library.focusedAsset()?.rating).toBe(4);
    library.updateAdjustment(id, { exposure: 2 });
    const asset = library.focusedAsset()!;
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      TestBed.inject(XmpStoreService).passthroughFor(id),
      { rating: asset.rating, flag: asset.flag, colorLabel: asset.colorLabel },
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');
    const descriptions = Array.from(
      document.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description'),
    );
    const cameraRawUri = 'http://ns.adobe.com/camera-raw-settings/1.0/';

    expect(document.querySelector('parseerror')).toBeNull();
    expect(descriptions.map((node) => node.getAttributeNS(cameraRawUri, 'Exposure2012'))).toEqual([
      '2',
      null,
    ]);
    expect(descriptions.map((node) => node.getAttributeNS(cameraRawUri, 'Vibrance'))).toEqual([
      '22',
      null,
    ]);
    expect(descriptions.some((node) => node.getAttributeNS(vendorUri, 'First') === 'keep')).toBe(
      true,
    );
    expect(
      descriptions.some((node) => node.getAttributeNS(vendorUri, 'Second') === 'keep-too'),
    ).toBe(true);
  });

  it('keeps a colliding-prefix foreign child subtree in its original namespace', () => {
    const foreignCrsUri = 'https://vendor.test/not-camera-raw';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:develop="http://ns.adobe.com/camera-raw-settings/1.0/"
            xmlns:crs="${foreignCrsUri}" develop:Exposure2012="1">
            <crs:VendorRecipe><crs:Step crs:Version="7" /></crs:VendorRecipe>
          </rdf:Description>
        </rdf:RDF>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );
    library.updateAdjustment(id, { exposure: 2 });
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      TestBed.inject(XmpStoreService).passthroughFor(id),
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');
    const recipe = document.getElementsByTagNameNS(foreignCrsUri, 'VendorRecipe')[0];
    const step = document.getElementsByTagNameNS(foreignCrsUri, 'Step')[0];

    expect(document.querySelector('parseerror')).toBeNull();
    expect(recipe).toBeDefined();
    expect(step?.getAttributeNS(foreignCrsUri, 'Version')).toBe('7');
    expect(TestBed.inject(XmpParserService).parseAdjustmentModel(written).model.exposure).toBe(2);
  });

  it('preserves descendant prefix rebinding inside an unknown subtree', () => {
    const outerUri = 'urn:vendor:A';
    const innerUri = 'urn:vendor:B';
    const xmp = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:v="${outerUri}">
            <v:Outer v:Scope="outer">
              <v:Inner xmlns:v="${innerUri}" v:Scope="inner"><v:Leaf /></v:Inner>
              <v:After />
            </v:Outer>
          </rdf:Description>
        </rdf:RDF>
      </x:xmpmeta>`;
    const id = library.enterSingleFileWorkspace(
      new Uint8Array([1]),
      'photo.dng',
      'photo-id',
      false,
      xmp,
    );
    const written = TestBed.inject(XmpSerializerService).serialize(
      library.adjustmentFor(id)(),
      TestBed.inject(XmpStoreService).passthroughFor(id),
    );
    const document = new DOMParser().parseFromString(written, 'text/xml');
    const outer = document.getElementsByTagNameNS(outerUri, 'Outer')[0];
    const inner = document.getElementsByTagNameNS(innerUri, 'Inner')[0];

    expect(document.querySelector('parseerror')).toBeNull();
    expect(outer?.getAttributeNS(outerUri, 'Scope')).toBe('outer');
    expect(document.getElementsByTagNameNS(outerUri, 'After')).toHaveLength(1);
    expect(inner?.getAttributeNS(innerUri, 'Scope')).toBe('inner');
    expect(document.getElementsByTagNameNS(innerUri, 'Leaf')).toHaveLength(1);
  });
});
