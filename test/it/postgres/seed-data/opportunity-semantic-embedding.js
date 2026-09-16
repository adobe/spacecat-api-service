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

import { createHash } from 'crypto';

/**
 * Immutable baseline `opportunity_semantic_embedding` rows for IT tests (Lookup Service, POST
 * .../opportunities/by-topics). Vectors are deterministic 1536-dim unit vectors so the RPC's
 * cosine ranking is exact and predictable: a query embedding equal to unit vector `e_i` scores
 * 1.0 against a row with `e_i` and 0.0 against any other axis (dropped by the default minScore).
 *
 * `source_hash`/`source_text`/`model`/`dims` mirror exactly what the real writer
 * (`syncOpportunitySemantic`) persists, so these rows exercise the real reader RPC, not a fixture
 * that assumes a shape.
 *
 * - OPPTY_1 (SITE_1, code-suggestions, NEW)       <- e0  ("banking" query axis)
 * - OPPTY_2 (SITE_1, broken-backlinks, RESOLVED)  <- e1  ("backlinks" query axis)
 * - OPPTY_3 drift row: site_id says SITE_1, entity_id (OPPTY_3) actually belongs to SITE_3 <- e0.
 *   Simulates a stale/cross-site index row (the index is derived, best-effort-written data) so the
 *   by-topics endpoint's own siteId re-check on the hydrated entity has something real to catch.
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */

const DIMS = 1536;
const MODEL = 'azure/text-embedding-3-small';

// pgvector literal for the unit vector with a 1 at position `i` (rest 0).
const unit = (i) => `[${Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;

// Mirror the shared writer's normalizeText + hashText (sha256 of lowercased, collapsed text).
const normalize = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const sourceHash = (t) => createHash('sha256').update(normalize(t)).digest('hex');

const row = ({
  siteId, entityId, entityType, sourceText, axis,
}) => ({
  site_id: siteId,
  entity_id: entityId,
  entity_type: entityType,
  source_type: 'topic',
  source_id: null,
  source_hash: sourceHash(sourceText),
  source_text: sourceText,
  embedding: unit(axis),
  model: MODEL,
  dims: DIMS,
  updated_by: 'it-seed',
});

const SITE_1 = '33333333-3333-4333-b333-333333333333';
const OPPTY_1 = 'aa111111-1111-4111-b111-111111111111';
const OPPTY_2 = 'aa222222-2222-4222-a222-222222222222';
const OPPTY_3 = 'aa333333-3333-4333-b333-333333333333';

export const opportunitySemanticEmbedding = [
  row({
    siteId: SITE_1, entityId: OPPTY_1, entityType: 'code-suggestions', sourceText: 'online banking security', axis: 0,
  }),
  row({
    siteId: SITE_1, entityId: OPPTY_2, entityType: 'broken-backlinks', sourceText: 'broken backlink sources', axis: 1,
  }),
  // Cross-site drift: row claims SITE_1 but OPPTY_3 belongs to SITE_3.
  row({
    siteId: SITE_1, entityId: OPPTY_3, entityType: 'code-suggestions', sourceText: 'drifted banking topic', axis: 0,
  }),
];
