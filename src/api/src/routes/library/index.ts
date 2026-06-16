/**
 * M1 library routes — Elysia plugin.
 *
 * Groups the four new slug-addressed routes under a single plugin:
 *   GET /api/folder/:slug/*   — catalog-backed folder listing (JSON)
 *   GET /api/image/:slug/*    — original file bytes (streamed)
 *   GET /api/thumb/:slug/*    — content-keyed thumbnail JPEG (immutable)
 *   GET /api/preview/:slug/*  — 1280px preview JPEG (immutable)
 *
 * Mounted in index.ts inside the authenticated sub-app alongside the
 * existing routes. Old /api/fs/* and /api/assets/* routes are untouched.
 */

import { Elysia } from 'elysia';
import { folderRoutes } from './folder.ts';
import { imageRoutes } from './image.ts';
import { thumbRoutes } from './thumb.ts';
import { previewRoutes } from './preview.ts';

export const libraryRoutes = new Elysia({ prefix: '/api' })
  .use(folderRoutes)
  .use(imageRoutes)
  .use(thumbRoutes)
  .use(previewRoutes);
