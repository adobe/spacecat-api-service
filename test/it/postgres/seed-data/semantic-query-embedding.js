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
 * Immutable baseline `semantic_query_embedding` rows for IT tests (Lookup Service, POST
 * .../opportunities/by-topics). Seeding these makes the endpoint's query embedding a durable-cache
 * HIT, so the IT never makes a real Azure embedding call (there is no external HTTP mocking in this
 * suite). Each cached query is a 1536-dim unit vector on the same axis as the opportunity rows it
 * is meant to match (see opportunity-semantic-embedding.js).
 *
 * The cache key is `text_hash + model + dims`, where `text_hash` = sha256 of the normalized query
 * text — computed here exactly as the reader (`getQueryEmbedding` → normalizeText/hashText) does,
 * so a POST body topic string of the same text resolves to these rows.
 *
 * - "online banking security" -> e0 (matches OPPTY_1 + the OPPTY_3 drift row)
 * - "broken backlinks"        -> e1 (matches OPPTY_2)
 *
 * Format: snake_case (v3 / PostgreSQL / PostgREST)
 */

const DIMS = 1536;
const MODEL = 'azure/text-embedding-3-small';

const unit = (i) => `[${Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
const normalize = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const textHash = (t) => createHash('sha256').update(normalize(t)).digest('hex');

const row = (text, axis) => ({
  text_hash: textHash(text),
  model: MODEL,
  dims: DIMS,
  normalized_text: normalize(text),
  embedding: unit(axis),
});

export const BANKING_QUERY = 'online banking security';
export const BACKLINKS_QUERY = 'broken backlinks';

export const semanticQueryEmbedding = [
  row(BANKING_QUERY, 0),
  row(BACKLINKS_QUERY, 1),
];
