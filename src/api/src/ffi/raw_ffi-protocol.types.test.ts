/** #3547: compile real protocol mutations; transpileModule skips type checks. */
import { expect, test } from 'bun:test';
import * as path from 'node:path';
import ts from 'typescript';

const protocolPath = path.join(import.meta.dir, 'raw_ffi-protocol.ts');
const source = await Bun.file(protocolPath).text();
const configPath = path.join(import.meta.dir, '../..', 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
}
const { options, errors } = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
);
if (errors.length > 0) {
  throw new Error(
    errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
  );
}
const canonicalPath = (fileName: string) => {
  const resolved = path.resolve(fileName);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

function diagnostics(mutated: string): string {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    canonicalPath(fileName) === canonicalPath(protocolPath)
      ? ts.createSourceFile(fileName, mutated, languageVersion, true)
      : original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([protocolPath], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('\n');
}

test('the current protocol typechecks', () => {
  expect(diagnostics(source)).toBe('');
});

test('adding an unregistered request variant fails compilation', () => {
  const mutated = source.replace(
    'export type FfiRequest =',
    "export type FfiRequest = { type: 'testMissingRequest'; id: number }",
  );
  expect(mutated).not.toBe(source);
  expect(diagnostics(mutated)).toContain("Property 'testMissingRequest' is missing");
});

test('omitting an existing request type fails compilation', () => {
  const mutated = source.replace('  histogram: true,\n', '');
  expect(mutated).not.toBe(source);
  expect(diagnostics(mutated)).toContain("Property 'histogram' is missing");
});

test('an unknown registry entry also fails compilation', () => {
  const mutated = source.replace('  histogram: true,', '  testUnknownRequest: true,');
  expect(mutated).not.toBe(source);
  expect(diagnostics(mutated)).toContain("'testUnknownRequest' does not exist");
});
