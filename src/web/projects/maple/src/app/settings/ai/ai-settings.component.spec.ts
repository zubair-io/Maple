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
    {
      id: 'strata',
      name: 'Strata',
      provider: 'openai',
      url: 'http://strata:8080/v1',
      concurrency: 2,
      has_key: true,
    },
    { id: 'claude', name: 'Claude', provider: 'anthropic', url: '', concurrency: 2, has_key: true },
  ],
  assignments: {
    describe: { connection_ids: ['gpu1', 'gpu2'], model: 'vision' },
    'generated-search': { connection_ids: ['gpu1'], model: 'gemma4:12b' },
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
      id: 'generated-search',
      name: 'Generated search',
      detail: 'Curated search collections',
      multiple: false,
      providers: ['ollama', 'openai'],
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
    http.expectOne('/api/ai/search-engine/').flush({
      status: { phase: 'stopped', vectors: 0, texts: 0, textReady: false, restarts: 0 },
      modelCacheDir: '/data/.maple/models/fastembed',
    });
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
    expect(fixture.nativeElement.querySelectorAll('.connection-card')).toHaveLength(5);
    expect(component.config()?.assignments['describe']?.connection_ids).toEqual(['gpu1', 'gpu2']);
    expect(
      fixture.nativeElement.querySelector('[aria-label="Model for Generated search on GPU one"]')
        .value,
    ).toBe('gemma4:12b');
    expect(fixture.nativeElement.querySelector('[aria-label="API key for Cloud"]').type).toBe(
      'password',
    );
  });
  it('offers a base URL only on OpenAI connections and saves what is typed', () => {
    const baseUrl = fixture.nativeElement.querySelector('[aria-label="Base URL for Cloud"]');
    expect(baseUrl.placeholder).toBe('https://api.openai.com/v1');
    expect(fixture.nativeElement.querySelector('[aria-label="Base URL for GPU one"]')).toBeNull();
    component.updateConnection('cloud', { url: 'http://strata:8080/v1' });
    expect(component.config()?.connections.find((c) => c.id === 'cloud')?.url).toBe(
      'http://strata:8080/v1',
    );
    expect(component.dirty()).toBe(true);
  });
  it('can add another connection without replacing existing servers', () => {
    component.addConnection();
    expect(component.config()?.connections).toHaveLength(6);
    component.save();
    const request = http.expectOne('/api/ai/connections/');
    expect(request.request.body.connections.slice(0, 2)).toEqual(CONFIG.connections.slice(0, 2));
    request.flush(component.config());
    expect(component.dirty()).toBe(false);
  });
  it('blocks removal while assigned, then removes an unused connection', () => {
    component.removeConnection('gpu2');
    expect(component.config()?.connections).toHaveLength(5);
    component.toggleConnection('describe', 'gpu2', false);
    component.removeConnection('gpu2');
    expect(component.config()?.connections).toHaveLength(4);
  });
  it('lets generated search pick any Ollama or OpenAI-compatible connection and its model', () => {
    component.setWorkerOpen('generated-search', true);
    http.expectOne('/api/ai/connections/probe').flush({ models: ['gemma4:12b'] });
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('#generated-search');
    const choices = [...card.querySelectorAll('mui-checkbox')].map((box: Element) =>
      box.textContent?.trim(),
    );
    expect(choices).toEqual([
      'GPU one (ollama)',
      'GPU two (ollama)',
      'Cloud (openai)',
      'Strata (openai)',
    ]);

    component.toggleConnection('generated-search', 'strata', true);
    const probe = http.expectOne('/api/ai/connections/probe');
    expect(probe.request.body).toEqual({
      connection: CONFIG.connections[3],
      models: true,
    });
    probe.flush({ models: ['qwen3-32b', 'gemma-3-27b'] });
    fixture.detectChanges();
    expect(component.config()?.assignments['generated-search']?.connection_ids).toEqual([
      'strata',
    ]);
    expect(component.modelChoices('generated-search', CONFIG.connections[3]!)).toEqual([
      { value: '', label: 'Select a model' },
      { value: 'qwen3-32b', label: 'qwen3-32b' },
      { value: 'gemma-3-27b', label: 'gemma-3-27b' },
    ]);
    component.chooseModel('generated-search', 'strata', 'qwen3-32b');

    component.save();
    const request = http.expectOne('/api/ai/connections/');
    expect(request.request.body.assignments['generated-search']).toEqual({
      connection_ids: ['strata'],
      model: 'qwen3-32b',
      connection_models: { strata: 'qwen3-32b' },
    });
    expect(request.request.body).not.toHaveProperty('embedder');
    request.flush(component.config());
  });
  it('offers no embedding connection: semantic search runs on the server', () => {
    expect(fixture.nativeElement.querySelector('[aria-label="Embedding endpoint URL"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('#semantic-search')).toBeNull();
    expect(fixture.nativeElement.querySelector('#search-engine-title').textContent).toBe(
      'Semantic search',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Runs on this server’s CPU with the bundled bge-m3 model',
    );
  });
  it('changing a vision assignment does not alter generated search', () => {
    component.toggleConnection('describe', 'cloud', true);
    http.expectOne('/api/ai/connections/probe').flush({ models: ['gpt-4o'], source: 'live' });
    expect(component.connectionModel('describe', 'cloud')).toBe('');
    expect(component.connectionModel('describe', 'gpu1')).toBe('vision');
    expect(component.config()?.assignments['describe']?.connection_ids).toEqual([
      'gpu1',
      'gpu2',
      'cloud',
    ]);
    expect(component.config()?.assignments['generated-search']).toEqual(
      CONFIG.assignments['generated-search'],
    );
  });
  it('changing a connection provider removes stale assignments and model', () => {
    component.providerChanged('gpu1', 'gemini');
    expect(component.config()?.assignments['describe']).toEqual({
      connection_ids: ['gpu2'],
      model: 'vision',
      connection_models: { gpu2: 'vision' },
    });
    expect(component.config()?.assignments['generated-search']).toEqual({
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
