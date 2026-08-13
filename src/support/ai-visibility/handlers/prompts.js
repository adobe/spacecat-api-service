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

/* eslint-disable max-statements-per-line -- AI Visibility handler surface */

import { PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountryForFts, requiredLlmFromQuery,
  llmToEngine, promptMatchesResponsesQuery, mentionedBrandRestLabel,
  PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT,
} from '../grpc-utils.js';

/**
 * Normalizes a relation `date` into an ISO `YYYY-MM-DD` string. The gRPC relation
 * value carries `date` as a protobuf Date message (`{ year, month, day }`, plus a
 * `$typeName` tag), not a scalar — emitting it verbatim leaks that struct to callers.
 * Passes an already-formatted string through unchanged; returns `null` when the date
 * is absent or incomplete.
 *
 * @param {object|string|null|undefined} d
 * @returns {string|null}
 */
function toIsoDate(d) {
  if (!d) { return null; }
  if (typeof d === 'string') { return d; }
  const { year, month, day } = d;
  if (!year || !month || !day) { return null; }
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

export async function handlePromptsResponses(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const promptQuery = (sp.get('prompt') ?? '').trim();
  const llm = requiredLlmFromQuery(sp);
  const raw = await clients.promptClient.prompts({
    country,
    llm,
    target: brandTarget(domain),
    range: { limit: PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT, offset: 0 },
    order: { by: PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME },
  });
  let prompts = raw.prompts || [];
  if (promptQuery) {
    prompts = prompts.filter((p) => promptMatchesResponsesQuery(p.prompt, promptQuery));
  }
  const total = prompts.length;
  const page = prompts.slice(offset, offset + limit);
  // `attempted[i]` records whether we actually issued the per-prompt relation call.
  // Without it a skipped prompt (missing identity → Promise.resolve(null)) is
  // indistinguishable from a relation call that fulfilled with a null value, which
  // hides why a row has no full response. Same identity check as the guard below.
  const hasRelationIdentity = (p) => Boolean(p.promptHash && String(p.serpId ?? '') && p.topicId);
  const attempted = page.map(hasRelationIdentity);
  const settled = await Promise.allSettled(
    page.map((p) => {
      const { promptHash } = p;
      const serpId = String(p.serpId ?? '');
      const { topicId } = p;
      if (!promptHash || !serpId || !topicId) { return Promise.resolve(null); }
      return clients.prRelationsClient.prompt({
        country, llm: p.llm || llm, promptHash, serpId, topicId,
      });
    }),
  );
  const relations = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  const data = page.map((p, i) => {
    const rel = relations[i]?.value ?? null;
    // Per-item relation status so callers (e.g. claims_extraction) can tell a real
    // full response from a degraded one. `error` was previously swallowed silently.
    let relationStatus;
    if (!attempted[i]) { relationStatus = 'skipped'; } else if (settled[i].status === 'rejected') { relationStatus = 'error'; } else { relationStatus = 'ok'; }
    // Response provenance. Preserves the exact legacy `response` value (nullish-coalesce
    // chain) while exposing whether it came from the full relation response or the
    // brief excerpt. LLMO-6585: claims must never be extracted from an excerpt that is
    // mistaken for the full answer, so the excerpt fallback is now explicit, not silent.
    const relResponse = rel?.response;
    const excerpt = p.briefResponse ?? '';
    const usedFullResponse = relResponse != null; // relation supplied a `response` field
    const response = usedFullResponse ? relResponse : excerpt;
    let responseSource;
    if (usedFullResponse) { responseSource = 'full'; } else if (excerpt !== '') { responseSource = 'excerpt'; } else { responseSource = 'none'; }
    return {
      prompt: p.prompt,
      promptHash: String(p.promptHash ?? ''),
      serpId: String(p.serpId ?? ''),
      topic: p.topicName,
      topicId: String(p.topicId ?? ''),
      engine: llmToEngine(p.llm || llm),
      response,
      responseExcerpt: p.briefResponse ?? '',
      responseSource,
      responseComplete: responseSource === 'full' && response.length > 0,
      relationStatus,
      date: toIsoDate(rel?.date),
      citedPages: Array.isArray(rel?.sources) ? rel.sources : [],
      mentionedBrands: (rel?.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
      mentionedBrandsCount: num(p.mentionedBrandsCount),
      sourcesCount: num(p.sourcesCount),
    };
  });
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handlePromptsResponsesLatest(sp, clients) {
  const promptHash = sp.get('promptHash')?.trim();
  const serpId = sp.get('serpId')?.trim();
  const topicId = sp.get('topicId')?.trim();
  if (!promptHash || !serpId || !topicId) {
    return {
      status: 400,
      body: { error: 'missing_params', message: 'promptHash, serpId, and topicId are required' },
    };
  }
  const country = resolveCountryForFts(sp);
  const llm = requiredLlmFromQuery(sp);
  const raw = await clients.prRelationsClient.prompt({
    country, llm, promptHash, serpId, topicId,
  });
  const v = raw.value ?? null;
  if (!v) { return { status: 200, body: { data: null } }; }
  return {
    status: 200,
    body: {
      data: {
        prompt: v.prompt,
        engine: llmToEngine(llm),
        topicId,
        response: v.response,
        citedPages: Array.isArray(v.sources) ? v.sources : [],
        mentionedBrands: (v.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
        date: toIsoDate(v.date),
      },
    },
  };
}
