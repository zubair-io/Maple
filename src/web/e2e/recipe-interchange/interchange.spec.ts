import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SemanticCase {
  id: string;
  supported: boolean;
  recipe: Record<string, unknown>;
}
interface MalformedCase {
  id: string;
  value: unknown;
}

test('20 Rust/Swift recipes survive actual IndexedDB and page reload; 8 malformed cases reject', async ({
  page,
  browser,
}) => {
  const directory = process.env['MAPLE_RECIPE_INTERCHANGE_ARTIFACTS'];
  if (!directory) throw new Error('Required real Rust/Swift artifact directory is missing');
  const input: { semantic: SemanticCase[]; malformed: MalformedCase[] } = JSON.parse(
    readFileSync(resolve(directory, 'swift.json'), 'utf8'),
  );
  expect(input.semantic).toHaveLength(20);
  expect(input.malformed).toHaveLength(8);
  expect(new Set(input.semantic.map((entry) => entry.id)).size).toBe(20);
  await page.goto('/');
  await page.waitForFunction(() => Reflect.has(window, 'recipeInterchange'));
  for (const entry of input.semantic) {
    await page.evaluate(
      (recipe) => Reflect.get(window, 'recipeInterchange').save(recipe),
      entry.recipe,
    );
  }
  await page.reload();
  await page.waitForFunction(() => Reflect.has(window, 'recipeInterchange'));
  const stored: Record<string, unknown>[] = await page.evaluate(() =>
    Reflect.get(window, 'recipeInterchange').list(),
  );
  expect(stored).toHaveLength(20);
  const semantic = [];
  for (const entry of input.semantic) {
    const recipe = stored.find((value) => value['name'] === entry.recipe['name']);
    expect(recipe, entry.id).toEqual(entry.recipe);
    const problem: string | null = await page.evaluate(
      (value) => Reflect.get(window, 'recipeInterchange').admission(value),
      recipe,
    );
    expect(problem === null, entry.id).toBe(entry.supported);
    semantic.push({
      id: entry.id,
      supported: entry.supported,
      recipe,
      accepted: problem === null,
      admissionError: problem,
    });
  }
  const malformed = [];
  for (const entry of input.malformed) {
    const error: string | null = await page.evaluate((value) => {
      try {
        Reflect.get(window, 'recipeInterchange').parse(value);
        return null;
      } catch (failure) {
        return String(failure);
      }
    }, entry.value);
    expect(error, entry.id).not.toBeNull();
    malformed.push({ id: entry.id, rejected: true, error });
  }
  writeFileSync(
    resolve(directory, 'browser.json'),
    JSON.stringify(
      {
        semantic,
        malformed,
        browser: {
          engine: browser.browserType().name(),
          version: browser.version(),
          storage: 'IndexedDB',
          reloaded: true,
        },
      },
      null,
      2,
    ),
  );
});
