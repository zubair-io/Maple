#!/usr/bin/env bun
/**
 * `npx maple` / `bun x maple` entry point. Runs under Bun because the native
 * bindings load through bun:ffi.
 */
import { runCli } from '../dist/index.js';

process.exitCode = await runCli(process.argv);
