#!/usr/bin/env node
/**
 * `npx maple` / `bun x maple` entry point. Runs under Node.js or Bun with
 * native bindings loaded via napi-rs (Node) or bun:ffi (Bun).
 */
import { runCli } from '../dist/index.js';

process.exitCode = await runCli(process.argv);
