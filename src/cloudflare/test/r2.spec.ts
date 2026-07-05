import { describe, it, expect } from 'vitest';
import { parseThumbPath, thumbR2Key } from '../src/r2';

describe('parseThumbPath', () => {
	it('parses a file at the library root', () => {
		expect(parseThumbPath('/api/thumb/main/IMG_001.jpg')).toEqual({
			slug: 'main',
			relDir: '',
			filename: 'IMG_001.jpg',
		});
	});

	it('parses a file in a nested directory', () => {
		expect(parseThumbPath('/api/thumb/main/vacation/2024/IMG_001.jpg')).toEqual({
			slug: 'main',
			relDir: 'vacation/2024',
			filename: 'IMG_001.jpg',
		});
	});

	it('decodes percent-encoded segments', () => {
		expect(parseThumbPath('/api/thumb/main/a%20b/photo%20%231.jpg')).toEqual({
			slug: 'main',
			relDir: 'a b',
			filename: 'photo #1.jpg',
		});
	});

	it('returns null for paths outside /api/thumb/*', () => {
		expect(parseThumbPath('/api/fs/thumb')).toBeNull();
		expect(parseThumbPath('/api/observability/config')).toBeNull();
	});

	it('returns null for a bare slug with no filename', () => {
		expect(parseThumbPath('/api/thumb/main')).toBeNull();
		expect(parseThumbPath('/api/thumb/main/')).toBeNull();
	});
});

describe('thumbR2Key', () => {
	it('matches the API-side scheme for a root-level file', () => {
		expect(thumbR2Key({ slug: 'main', relDir: '', filename: 'IMG_001.jpg' })).toBe(
			'thumbs/main/IMG_001.jpg',
		);
	});

	it('matches the API-side scheme for a nested file', () => {
		expect(thumbR2Key({ slug: 'main', relDir: 'vacation/2024', filename: 'IMG_001.jpg' })).toBe(
			'thumbs/main/vacation/2024/IMG_001.jpg',
		);
	});

	it('produces the same key whether derived from a parsed path or built directly', () => {
		const parsed = parseThumbPath('/api/thumb/main/a%20b/photo%20%231.jpg');
		expect(parsed).not.toBeNull();
		expect(thumbR2Key(parsed!)).toBe(
			thumbR2Key({ slug: 'main', relDir: 'a b', filename: 'photo #1.jpg' }),
		);
	});
});
