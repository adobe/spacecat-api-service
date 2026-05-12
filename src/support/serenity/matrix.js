/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// Hackathon hardcode: (brandId, category, market, language) -> Semrush
// (workspaceId, projectId). A prompt with N regions fans out to N rows that
// share (category, language) but differ on market. The `slug` mirrors the
// Python tooling's matrix CSV for cross-reference. Override at deploy time by
// setting SEMRUSH_PROJECT_MATRIX to a JSON blob of the same shape:
//   { "workspaceId": "...", "rows": [{ brandId, category, market, language, projectId, slug }] }
const STATIC_MATRIX = {
  workspaceId: '',
  rows: [],
};

export class MatrixNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatrixNotConfiguredError';
  }
}

function loadMatrixFromEnv(env) {
  const raw = env?.SEMRUSH_PROJECT_MATRIX;
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new MatrixNotConfiguredError('SEMRUSH_PROJECT_MATRIX is set but is not valid JSON');
  }
}

function normalizeMarket(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCategory(value) {
  return String(value || '').trim();
}

export function loadMatrix(env) {
  const data = loadMatrixFromEnv(env) || STATIC_MATRIX;
  const workspaceId = data?.workspaceId;
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return { workspaceId, rows };
}

function indexRows(rows) {
  const byTriple = new Map();
  for (const row of rows) {
    const key = [
      String(row.brandId || ''),
      normalizeCategory(row.category),
      normalizeMarket(row.market),
      normalizeLanguage(row.language),
    ].join('|');
    byTriple.set(key, row);
  }
  return byTriple;
}

function assertConfigured(workspaceId, rows) {
  if (!workspaceId || rows.length === 0) {
    throw new MatrixNotConfiguredError('Semrush project matrix is not configured');
  }
}

/**
 * Resolve a single (category, market, language) triple to a Semrush
 * (workspaceId, projectId) pair. Returns null when the matrix is configured
 * but has no row for this triple.
 */
export function resolveProject(env, brandId, { category, market, language }) {
  const { workspaceId, rows } = loadMatrix(env);
  assertConfigured(workspaceId, rows);
  const idx = indexRows(rows);
  const key = [
    String(brandId || ''),
    normalizeCategory(category),
    normalizeMarket(market),
    normalizeLanguage(language),
  ].join('|');
  const row = idx.get(key);
  if (!row) {
    return null;
  }
  return { workspaceId, projectId: row.projectId, slug: row.slug || null };
}

/**
 * Fan out a single prompt's regions into the set of Semrush projects it
 * should land in. Returns `{ matched, skipped }` so callers can surface
 * regions that have no matrix entry as warnings rather than failures.
 */
export function resolveProjectsForPrompt(env, brandId, { category, regions, language }) {
  const matched = [];
  const skipped = [];
  for (const region of regions || []) {
    const match = resolveProject(env, brandId, { category, market: region, language });
    if (match) {
      matched.push({ ...match, market: normalizeMarket(region) });
    } else {
      skipped.push({ category, market: normalizeMarket(region), language });
    }
  }
  return { matched, skipped };
}

/**
 * Return every distinct project configured for a brand. Drives the list
 * endpoint, which aggregates prompts across all of them.
 */
export function listProjectsForBrand(env, brandId) {
  const { workspaceId, rows } = loadMatrix(env);
  assertConfigured(workspaceId, rows);
  const filtered = brandId
    ? rows.filter((row) => String(row.brandId || '') === String(brandId))
    : rows;
  const seen = new Set();
  const out = [];
  for (const row of filtered) {
    if (!seen.has(row.projectId)) {
      seen.add(row.projectId);
      out.push({
        workspaceId,
        projectId: row.projectId,
        slug: row.slug || null,
        category: row.category,
        market: normalizeMarket(row.market),
        language: normalizeLanguage(row.language),
      });
    }
  }
  return out;
}

/**
 * Lookup the (category, market, language) for a given Semrush project,
 * needed by list to attribute aggregated prompts back to their facets.
 */
export function describeProject(env, brandId, projectId) {
  const projects = listProjectsForBrand(env, brandId);
  return projects.find((p) => p.projectId === projectId) || null;
}
