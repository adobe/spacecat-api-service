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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';

import { listGlobalModelCatalog, listSliceModels } from './handlers/markets.js';
import { listMarkets } from './subworkspace-projects.js';

/**
 * Net-new customer base package (LLMO-6338 / LLMO-6554): the AI models a
 * brand-new Serenity market gets out of the box, before a customer requests
 * anything extra (Copilot, ChatGPT Paid — opt-in only, never auto-assigned;
 * see the LLMO-6338 Slack decision thread). Values are Semrush AI-model
 * catalog `key`s (`SerenityModel.key` — "CBF_model value the Reporting API
 * expects"), the same taxonomy as `ELEMENT_MODELS` (../elements/constants.js).
 *
 * "ChatGPT w/websearch" is Semrush's single search-enabled ChatGPT model,
 * `search-gpt` — there is no separate free/paid split at the catalog level
 * (the non-search variant is `gpt-5`, "ChatGPT (No Search)", not part of this
 * default set). "Google (3)" is AI Overview + AI Mode + the Gemini chatbot.
 */
export const NET_NEW_DEFAULT_MODEL_KEYS = Object.freeze([
  'search-gpt', // ChatGPT w/ web search
  'google-ai-overview',
  'google-ai-mode',
  'gemini-2.5-flash',
  'claude-sonnet-4',
  'perplexity',
  'grok-3',
  'deepseek',
]);

/**
 * Resolves the canonical net-new default model set against the LIVE global
 * catalog (`GET /serenity/models` with no slice params) by matching `key`
 * against {@link NET_NEW_DEFAULT_MODEL_KEYS}. A catalog entry missing from the
 * live response is simply skipped (best-effort) rather than failing the
 * caller — a partial default is better than none.
 *
 * @param {any} transport - Serenity transport.
 * @param {any} [log]
 * @returns {Promise<string[]>} catalog model ids (NOT keys) to attach.
 */
export async function resolveCanonicalDefaultModelIds(transport, log) {
  try {
    const { items } = await listGlobalModelCatalog(transport);
    return items
      .filter((m) => hasText(m?.key) && NET_NEW_DEFAULT_MODEL_KEYS.includes(m.key))
      .map((m) => m.id)
      .filter(hasText);
  } catch (e) {
    log?.warn?.('resolveCanonicalDefaultModelIds: global model catalog read failed (non-fatal)', {
      error: e?.message,
    });
    return [];
  }
}

/**
 * Resolves the model ids (catalog `id`s) to auto-assign to a NEW market on an
 * EXISTING sub-workspace, so a market is never created with zero models by
 * default (LLMO-6554 — the gap LLMO-6338 opened by removing manual model
 * selection without replacing it with an automatic default; see
 * serenity-docs#72 for the "dark draft market" failure mode this closes).
 *
 * Precedence:
 *   1. Mirror the brand's own existing models: if any of the brand's current
 *      markets already has ≥1 model attached, reuse THAT market's model set,
 *      so every market on a brand tracks the same LLMs — a brand provisioned
 *      with the migrated 10-LLM tier, or one that has since customized its
 *      set, keeps that set on every new market it adds. Markets are checked in
 *      listing order until one with a non-empty model set is found (a market
 *      created before this fix landed may still have zero models).
 *   2. Canonical net-new default ({@link resolveCanonicalDefaultModelIds}):
 *      no existing market has any models yet (a brand-new brand's first
 *      market on this sub-workspace).
 *
 * Never throws: any transport failure degrades to an empty list (the caller's
 * existing empty-modelIds handling takes over), so a catalog/listing hiccup
 * can't fail an otherwise-successful market create.
 *
 * @param {any} transport - Serenity transport.
 * @param {string} workspaceId - the brand's (already-existing) sub-workspace id.
 * @param {string} brandId - the brand UUID (threaded through to the slice DTO only).
 * @param {any} [log]
 * @returns {Promise<string[]>} catalog model ids to attach.
 */
export async function resolveDefaultModelIds(transport, workspaceId, brandId, log) {
  try {
    const existingMarkets = await listMarkets(transport, workspaceId, brandId);
    for (const market of existingMarkets) {
      if (!hasText(market?.semrushProjectId)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const { items } = await listSliceModels(transport, workspaceId, market.semrushProjectId);
      /** @type {string[]} */
      const ids = [];
      for (const m of items) {
        if (m && hasText(m.id)) {
          ids.push(m.id);
        }
      }
      if (ids.length > 0) {
        return ids;
      }
    }
  } catch (e) {
    log?.warn?.('resolveDefaultModelIds: existing-market mirror read failed (non-fatal)', {
      workspaceId, brandId, error: e?.message,
    });
  }
  return resolveCanonicalDefaultModelIds(transport, log);
}
