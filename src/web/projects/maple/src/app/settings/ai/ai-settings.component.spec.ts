import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type AiConnectionsResponse } from '@maple-common';
import { AiSettingsComponent } from './ai-settings.component';

const CONFIG: AiConnectionsResponse = {
  connections: [
    { id: 'gpu1', name: 'GPU one', provider: 'ollama', url: 'http://gpu1:11434', concurrency: 2 },
    { id: 'gpu2', name: 'GPU two', provider: 'ollama', url: 'http://gpu2:11434', concurrency: 1 },
    { id: 'cloud', name: 'Cloud', provider: 'openai', url: '', concurrency: 2, has_key: true },
  ],
  assignments: {
    describe: { connection_ids: ['gpu1', 'gpu2'], model: 'vision' },
    'semantic-search': { connection_ids: ['gpu1'], model: 'bge-m3' },
  },
  available_workers: [
    {
      id: 'describe',
      name: 'Describe',
      detail: 'Captions',
      multiple: true,
      providers: ['ollama', 'openai'],
    },
    {
      id: 'semantic-search',
      name: 'Semantic search',
      detail: 'Embeddings',
      multiple: false,
      providers: ['ollama'],
    },
  ],
};

describe('AI connections and assignments', () => {
  let fixture: ComponentFixture<AiSettingsComponent>;
  let component: AiSettingsComponent;
  let http: HttpTestingController;
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AiSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AiSettingsComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/ai/connections/').flush(structuredClone(CONFIG));
    fixture.detectChanges();
  });
  afterEach(() => http.verify());
  it('discovers selected connection models on expansion, preserving selections', () => {
    http.expectNone('/api/ai/connections/probe');
    component.setWorkerOpen('describe', true);
    const requests = http.match('/api/ai/connections/probe');
    expect(requests.map((r) => r.request.body.connection.id)).toEqual(['gpu1', 'gpu2']);
    component.setWorkerOpen('describe', false);
    http.expectNone('/api/ai/connections/probe');
    requests.forEach((r) => r.flush({ models: ['discovered-model'] }));
    expect(component.connectionModel('describe', 'gpu1')).toBe('vision');
    expect(component.dirty()).toBe(false);
    component.setWorkerOpen('describe', true);
    http.match('/api/ai/connections/probe').forEach((r) => r.flush({ models: ['new-model'] }));
    expect(component.models()['gpu1']).toEqual(['new-model']);
  });
  it('renders all saved connections and independent worker models', () => {
    expect(fixture.nativeElement.querySelectorAll('.connection-card')).toHaveLength(3);
    expect(component.config()?.assignments['describe']?.connection_ids).toEqual(['gpu1', 'gpu2']);
    expect(
      fixture.nativeElement.querySelector('[aria-label="Model for Semantic search on GPU one"]')
        .value,
    ).toBe('bge-m3');
    expect(fixture.nativeElement.querySelector('[aria-label="API key for Cloud"]').type).toBe(
      'password',
    );
  });
  it('can add another connection without replacing existing servers', () => {
    component.addConnection();
    expect(component.config()?.connections).toHaveLength(4);
    component.save();
    const request = http.expectOne('/api/ai/connections/');
    expect(request.request.body.connections.slice(0, 2)).toEqual(CONFIG.connections.slice(0, 2));
    request.flush(component.config());
    expect(component.dirty()).toBe(false);
  });
  it('blocks removal while assigned, then removes an unused connection', () => {
    component.removeConnection('gpu2');
    expect(component.config()?.connections).toHaveLength(3);
    component.toggleConnection('describe', 'gpu2', false);
    component.removeConnection('gpu2');
    expect(component.config()?.connections).toHaveLength(2);
  });
  it('changing a vision assignment does not alter semantic search', () => {
    component.toggleConnection('describe', 'cloud', true);
    http.expectOne('/api/ai/connections/probe').flush({ models: ['gpt-4o'], source: 'live' });
    expect(component.connectionModel('describe', 'cloud')).toBe('');
    expect(component.connectionModel('describe', 'gpu1')).toBe('vision');
    expect(component.config()?.assignments['describe']?.connection_ids).toEqual([
      'gpu1',
      'gpu2',
      'cloud',
    ]);
    expect(component.config()?.assignments['semantic-search']).toEqual(
      CONFIG.assignments['semantic-search'],
    );
  });
  it('changing a connection provider removes stale assignments and model', () => {
    component.providerChanged('gpu1', 'gemini');
    expect(component.config()?.assignments['describe']).toEqual({
      connection_ids: ['gpu2'],
      model: 'vision',
      connection_models: { gpu2: 'vision' },
    });
    expect(component.config()?.assignments['semantic-search']).toEqual({
      connection_ids: [],
      model: '',
      connection_models: {},
    });
  });
  it('keeps a separate model for every selected connection', () => {
    component.toggleConnection('describe', 'cloud', true);
    http.expectOne('/api/ai/connections/probe').flush({ models: ['gpt-4o'] });
    component.setModel('describe', 'gpt-4o', 'cloud');
    component.setModel('describe', 'local-model', 'gpu2');
    expect(component.config()?.assignments['describe']?.connection_models).toEqual({
      gpu1: 'vision',
      gpu2: 'local-model',
      cloud: 'gpt-4o',
    });
    component.save();
    const request = http.expectOne('/api/ai/connections/');
    expect(request.request.body.assignments.describe.connection_models.cloud).toBe('gpt-4o');
    request.flush(component.config());
  });
  it('discovery preserves the selected model and ignores stale endpoint responses', () => {
    const connection = component.config()!.connections[0]!;
    component.probe(connection, true);
    const req = http.expectOne('/api/ai/connections/probe');
    component.updateConnection('gpu1', { url: 'http://new:11434' });
    req.flush({ models: ['wrong-model'] });
    expect(component.models()['gpu1']).toEqual([]);
    expect(component.config()?.assignments['describe']?.model).toBe('vision');
  });
  it('preserves drafts on save failure and displays the API error', () => {
    component.setModel('describe', 'new-vision');
    component.save();
    http
      .expectOne('/api/ai/connections/')
      .flush({ error: 'Unknown connection' }, { status: 400, statusText: 'Bad Request' });
    expect(component.error()).toBe('Unknown connection');
    expect(component.dirty()).toBe(true);
    expect(component.config()?.assignments['describe']?.model).toBe('new-vision');
  });
});
