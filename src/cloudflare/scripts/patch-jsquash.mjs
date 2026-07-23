import { readFile, writeFile } from 'node:fs/promises';

const codecFiles = [
	'node_modules/@jsquash/avif/codec/dec/avif_dec.js',
	'node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.js',
];

const invalidImportMetaAssignment =
	/\s*if\s*\(\s*import\.meta\.url\s*===\s*undefined\s*\)\s*\{\s*import\.meta\.url\s*=\s*['"]https:\/\/localhost['"];?\s*\}/;

for (const file of codecFiles) {
	const source = await readFile(file, 'utf8');
	const patched = source.replace(invalidImportMetaAssignment, '');
	if (patched === source) {
		if (source.includes('import.meta.url =')) {
			throw new Error(`Unsupported jSquash import.meta.url assignment in ${file}`);
		}
		continue;
	}
	await writeFile(file, patched);
}
