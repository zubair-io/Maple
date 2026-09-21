import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PrivacyComponent } from './privacy.component';

describe('PrivacyComponent', () => {
  let fixture: ComponentFixture<PrivacyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PrivacyComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(PrivacyComponent);
    fixture.detectChanges();
  });

  it('accurately describes native and self-hosted diagnostics', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('do not send diagnostics directly to Just Maple');
    expect(text).toContain('Apple may provide crash reports');
    expect(text).toContain('Just Maple does not receive this data');
    expect(text).toContain('Effective September 21, 2026');
  });
});
