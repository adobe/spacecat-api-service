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

/**
 * Canonical allowlist for the `prompts.source` write chokepoint (SITES-47870).
 *
 * `source` records which pipeline/initiative produced a prompt; the LLMO usage
 * report groups by it (one column per source), and — since the source is now
 * part of the prompt uniqueness key `(brand_id, lower(text), sorted_regions,
 * source)` — the same text produced by two pipelines coexists as separate rows.
 *
 * The DRS-side canonical registry lives in
 * `llmo-data-retrieval-service` `src/common/models/prompt_source.py`
 * (`TRACKED_PROMPT_SOURCES`). This module MUST mirror `TRACKED_PROMPT_SOURCES`;
 * it additionally permits the legacy/UI source values already present in the
 * column so the chokepoint does not reject writers that predate the registry.
 */

/**
 * Pipeline sources — mirror of DRS `TRACKED_PROMPT_SOURCES` keys. A new
 * prompt-generation pipeline registers its source here AND in the DRS module.
 * @type {string[]}
 */
export const TRACKED_PROMPT_SOURCES = [
  'gsc',
  'base_url',
  'citation_attempt',
  'strategy-chat',
  'semrush',
  'synthetic_personas',
];

/**
 * Legacy / UI-originated source values already written to `prompts.source`
 * before the registry existed (see the column comment in mysticat-data-service):
 * the schema default `config`, CSV `sheet`, and pre-registry writers including
 * hyphen/underscore drift variants. Permitted so the chokepoint does not break
 * existing writers or UI prompt creation. A deferred canonicalization pass
 * (SITES-47870 §10) will collapse the drift variants and shrink this list.
 * @type {string[]}
 */
export const PERMITTED_LEGACY_SOURCES = [
  'config',
  'sheet',
  'brand-concierge',
  'page-content',
  'synthetic-personas',
  'citation-attempt',
  'agentic_traffic',
];

/** Full allowlist accepted at the write boundary. */
export const PERMITTED_PROMPT_SOURCES = new Set([
  ...TRACKED_PROMPT_SOURCES,
  ...PERMITTED_LEGACY_SOURCES,
]);

/**
 * @param {string} source
 * @returns {boolean} true if `source` may be persisted to `prompts.source`.
 */
export function isPermittedSource(source) {
  return PERMITTED_PROMPT_SOURCES.has(source);
}

/**
 * Write-boundary chokepoint (SITES-47870 / D2). Throws a 400-typed error unless
 * `source` is a permitted value. Covers UI-originated writes (e.g. `semrush` /
 * `synthetic_personas` recommendation-accept) that never touch the DRS writer,
 * so a client cannot introduce an untracked source the usage report can't
 * attribute to a column.
 *
 * @param {string} source - resolved prompt source (after the `|| 'config'` default)
 * @throws {Error} with `.status = 400` when the source is not permitted
 */
export function assertPermittedSource(source) {
  if (!isPermittedSource(source)) {
    // Echo the rejected value JSON-escaped and length-capped so a crafted source
    // (newlines, control chars) cannot forge log lines, and keep internal repo/
    // file names out of this client-facing 400 message.
    const shown = JSON.stringify(String(source).slice(0, 64));
    const err = new Error(
      `Unregistered prompt source ${shown}. It must be a registered prompt source.`,
    );
    err.status = 400;
    throw err;
  }
}
