import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { RecipeExportDialogComponent } from './recipe-export-dialog.component';
import { ExportRecipeQueueService } from '../export-recipe-queue.service';
import { DEFAULT_EXPORT_RECIPE, parseExportRecipe } from '../../generated/export-recipe.generated';
import { MuiExportOptionsFieldsComponent } from '../../ui/export-modal/mui-export-options-fields.component';
function mount() {
  TestBed.configureTestingModule({
    imports: [RecipeExportDialogComponent],
    providers: [
      {
        provide: ExportRecipeQueueService,
        useValue: {
          running: signal(false),
          remaining: signal(0),
          summary: signal(null),
          record: signal(null),
          error: signal(null),
          progress: signal(null),
          serverAvailable: false,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RecipeExportDialogComponent);
  fixture.componentRef.setInput('visible', true);
  fixture.detectChanges();
  return fixture;
}
describe('recipe encoder quality controls (#4197)', () => {
  for (const format of ['jpeg', 'avif', 'webp', 'png', 'tiff'])
    it(`exposes only supported ${format} quality`, () => {
      const fixture = mount();
      const component = fixture.componentInstance;
      component.setFormat(format);
      fixture.detectChanges();
      const fields = fixture.debugElement.query(By.directive(MuiExportOptionsFieldsComponent))
        .componentInstance as MuiExportOptionsFieldsComponent;
      expect(fields.qualityVisible()).toBe(['jpeg', 'avif'].includes(format));
      expect(fixture.nativeElement.textContent.includes('Custom quality')).toBe(format === 'avif');
      if (fields.qualityVisible()) {
        fields.onQualityCommitted('55');
        fixture.detectChanges();
        expect(component.recipe().quality).toBe(55);
      } else expect(component.recipe().quality).toBeNull();
    });
  for (const format of ['avif'])
    it(`preserves imported automatic ${format} quality until explicit user selection`, () => {
      const fixture = mount();
      const component = fixture.componentInstance;
      component.recipe.set(parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, format, quality: null }));
      fixture.detectChanges();
      expect(component.recipe().quality).toBeNull();
      expect(fixture.nativeElement.textContent).toContain(
        'Automatic uses the shared recipe default',
      );
      const custom = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
        (button) => (button as HTMLButtonElement).textContent?.trim() === 'Custom quality',
      ) as HTMLButtonElement;
      expect(custom).toBeDefined();
      custom.click();
      fixture.detectChanges();
      const fields = fixture.debugElement.query(By.directive(MuiExportOptionsFieldsComponent))
        .componentInstance as MuiExportOptionsFieldsComponent;
      fields.onQualityCommitted('64');
      fixture.detectChanges();
      expect(component.recipe().quality).toBe(64);
      const automatic = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
        (button) => (button as HTMLButtonElement).textContent?.trim() === 'Automatic',
      ) as HTMLButtonElement;
      automatic.click();
      fixture.detectChanges();
      component.setFormat('jpeg');
      expect(component.recipe().quality).toBe(DEFAULT_EXPORT_RECIPE.quality);
    });
});

it('preserves unsupported imported WebP quality until the explicit lossless action', () => {
  const fixture = mount();
  const component = fixture.componentInstance;
  component.recipe.set(
    parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, format: 'webp', quality: 55 }),
  );
  fixture.detectChanges();
  expect(component.recipe().quality).toBe(55);
  expect(component.problem()).toContain('Lossless');
  expect(fixture.nativeElement.textContent).toContain('imported quality 55');
  const clear = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
    (button) => (button as HTMLButtonElement).textContent?.trim() === 'Use lossless quality',
  ) as HTMLButtonElement;
  clear.click();
  fixture.detectChanges();
  expect(component.recipe().quality).toBeNull();
  expect(component.problem()).toBeNull();
});

it('does not label an unknown imported encoder as lossless', () => {
  const fixture = mount();
  const component = fixture.componentInstance;
  component.recipe.set(
    parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, format: 'future-encoder', quality: 55 }),
  );
  fixture.detectChanges();
  expect(component.problem()).toContain('Unsupported format');
  expect(fixture.nativeElement.textContent).not.toContain('Use lossless quality');
  expect(component.recipe().quality).toBe(55);
});
