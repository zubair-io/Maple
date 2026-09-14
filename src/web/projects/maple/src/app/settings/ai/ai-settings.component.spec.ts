import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type AiConfigResponse } from '@maple-common';
import { AiSettingsComponent } from './ai-settings.component';

const MOCK_CONFIG: AiConfigResponse = {
  providers: {
    ollama: {
      url: 'http://localhost:11434',
      servers: null,
    },
    openai: { has_key: false },
    anthropic: { has_key: true },
    gemini: { has_key: false },
  },
  workers: {
    describe: { provider: 'ollama', model: 'gemma4:12b' },
    'video-describe': { provider: 'ollama', model: 'gemma4:12b' },
  },
  available_workers: [
    { id: 'describe', name: 'Describe (Image Captioning & OCR)' },
    { id: 'video-describe', name: 'Video Describe (Video Summarization)' },
  ],
};

describe('AiSettingsComponent', () => {
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
  });

  afterEach(() => http.verify());

  async function load(): Promise<void> {
    fixture.detectChanges(); // ngOnInit → GET /api/ai/config
    const req = http.expectOne('/api/ai/config');
    expect(req.request.method).toBe('GET');
    req.flush(MOCK_CONFIG);

    // Initial fetchModels for ollama
    const modelsReq = http.expectOne('/api/ai/models');
    expect(modelsReq.request.method).toBe('POST');
    modelsReq.flush({ models: ['gemma4:12b', 'qwen2.5-vl:7b'], provider: 'ollama' });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('loads configuration and populates provider status', async () => {
    await load();
    expect(component.isProviderConfigured('ollama')).toBe(true);
    expect(component.isProviderConfigured('anthropic')).toBe(true);
    expect(component.isProviderConfigured('openai')).toBe(false);
  });

  it('switches provider and fetches models', async () => {
    await load();
    component.selectProvider('openai');

    const req = http.expectOne('/api/ai/models');
    expect(req.request.body.provider).toBe('openai');
    req.flush({ models: ['gpt-4o', 'gpt-4o-mini'], provider: 'openai' });

    expect(component.activeProvider()).toBe('openai');
    expect(component.selectedModel()).toBe('gpt-4o-mini');
  });

  it('assigns active provider and model to a worker', async () => {
    await load();
    component.selectProvider('anthropic');
    const req = http.expectOne('/api/ai/models');
    req.flush({ models: ['claude-3-5-haiku-20241022'], provider: 'anthropic' });

    component.onModelChange('claude-3-5-haiku-20241022');
    component.assignActiveToWorker('describe');

    expect(component.workerAssignments()['describe']).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
    });
  });

  it('saves configuration via PUT /api/ai/config', async () => {
    await load();
    component.assignActiveToWorker('describe');
    component.save();

    const putReq = http.expectOne('/api/ai/config');
    expect(putReq.request.method).toBe('PUT');
    putReq.flush({ ok: true });

    expect(component.saveState().kind).toBe('saved');
  });
});
