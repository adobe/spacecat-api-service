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

import { resolveElementModel } from '../constants.js';

/** Max parallel intent-filtered PROMPTS calls when enriching `userIntent`. */
export const INTENT_ENRICH_CONCURRENCY = 5;

/**
 * Builds the payload for the Prompts element ({@link ELEMENT_IDS.PROMPTS}).
 *
 * The element is a `table` — it returns one row per prompt
 * (`blocks.data[] = { prompt, prompt_topic, primary_intent, volume }`), which the
 * Prompts (count) endpoint surfaces as `{ count, prompts }`. It is the building
 * block for the prompt healthcheck (both metrics are per project):
 * - **intent coverage** — group the returned rows on `primary_intent`; no filter
 *   needed (the intent is on every row).
 * - **branded / unbranded** — the branded signal is NOT a row column; it is a
 *   `tags` value (`type__branded` / `type__non-branded`). So branded% is a
 *   `tag`-filtered count over the total. Verified against prod (Lovesac, one
 *   project): branded 510 + non-branded 687 = total 1197 → 43%.
 *
 * The advanced filter is an `and` group whose members are added only when the
 * corresponding input is present:
 * - **model** — always included (defaults to `search-gpt` via
 *   {@link resolveElementModel}); a one-member `or` group on `CBF_model`, mirroring
 *   the shape Semrush's own UI sends for this element.
 * - **tags** — each value becomes its own `tags contains <value>` clause; multiple
 *   tags are AND-ed (a prompt must carry all). Callers pass the FULL prefixed tag
 *   value — the element's tag taxonomy varies by workspace (`type__`, `category__`,
 *   `intent__`, `source__`, `topic__`), so no prefix is assumed here. e.g. pass
 *   `type__branded` for the branded count, `category__Brand` for a category filter.
 * - **projectIds** — a `CBF_project` `or` group; omitted → all projects in the
 *   (sub-)workspace. The UI already surfaces these as `semrush_project_id` via the
 *   URL Inspector filter-dimensions `regions`.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI
 *   platform code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Alias for `model`; `model` wins when both set.
 * @param {string[]} [params.tags] - Full tag values to filter on (AND-ed), e.g.
 *   `type__branded`, `category__Brand`. Empty/omitted → no tag filter.
 * @param {string[]} [params.projectIds] - Semrush project UUIDs to scope to.
 *   Empty/omitted → all projects in the (sub-)workspace.
 */
export function buildPromptsPayload({
  model, platform, tags = [], projectIds = [],
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const filters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];

  for (const tag of tags) {
    filters.push({ op: 'contains', val: tag, col: 'tags' });
  }

  if (projectIds.length > 0) {
    filters.push({
      op: 'or',
      filters: projectIds.map((projectId) => ({ op: 'eq', val: projectId, col: 'CBF_project' })),
    });
  }

  return {
    comparison_data_formatting: 'union',
    filters: {
      advanced: { op: 'and', filters },
    },
  };
}

/**
 * @typedef {object} PromptRow
 * @property {string} prompt - The prompt text (the question a user asked the LLM).
 * @property {string} prompt_topic - The topic the prompt belongs to. Assigned by a
 *   Semrush-developed model that groups together prompts which ask similar things and
 *   receive similar replies. This is NOT a tag — it is a derived grouping, one topic
 *   per prompt.
 * @property {string} primary_intent - The primary intent of the `prompt_topic` (e.g.
 *   `informational`), i.e. the intent is a property of the topic, not the individual
 *   prompt. This is the field the healthcheck's intent-coverage metric groups on.
 * @property {number} volume - Estimated number of times per month a user asked the LLM
 *   a question about this topic. A per-topic estimate, so prompts sharing a topic carry
 *   the same volume.
 * @property {string} [userIntent] - The prompt's OWN intent (a lowercased Semrush intent
 *   key, e.g. `commercial`), independent of the topic's `primary_intent`. Present only
 *   when the caller opts into enrichment; `''` when the prompt has no intent tag. Added by
 *   the service (`getPrompts`), NOT by `transformPromptsResponse`.
 */

/**
 * Transforms the raw Semrush Prompts element response into `{ count, prompts }`.
 * The element returns a `table` of prompt rows (`blocks.data[]`); we pass the raw
 * Semrush field names through unchanged (`prompt`, `prompt_topic`,
 * `primary_intent`, `volume`) and report `count` = number of rows.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {{ count: number, prompts: PromptRow[] }}
 */
export function transformPromptsResponse(raw) {
  const rows = Array.isArray(raw?.blocks?.data) ? raw.blocks.data : [];
  const prompts = rows.map((row) => ({
    prompt: row?.prompt,
    prompt_topic: row?.prompt_topic,
    primary_intent: row?.primary_intent,
    volume: row?.volume,
  }));
  return { count: prompts.length, prompts };
}
