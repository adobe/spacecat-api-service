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

import { PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountryForFts, requiredLlmFromQuery,
  llmToEngine, promptMatchesResponsesQuery, mentionedBrandRestLabel,
  PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT,
} from '../grpc-utils.js';

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
  const relations = await Promise.all(
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
  const data = page.map((p, i) => {
    const rel = relations[i]?.value ?? null;
    return {
      prompt: p.prompt,
      prompt_hash: String(p.promptHash ?? ''),
      serp_id: String(p.serpId ?? ''),
      topic: p.topicName,
      topic_id: String(p.topicId ?? ''),
      engine: llmToEngine(p.llm || llm),
      response: rel?.response ?? p.briefResponse ?? '',
      response_excerpt: p.briefResponse ?? '',
      cited_pages: Array.isArray(rel?.sources) ? rel.sources : [],
      mentioned_brands: (rel?.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
      mentioned_brands_count: num(p.mentionedBrandsCount),
      sources_count: num(p.sourcesCount),
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
  const promptHash = sp.get('prompt_hash')?.trim();
  const serpId = sp.get('serp_id')?.trim();
  const topicId = sp.get('topic_id')?.trim();
  if (!promptHash || !serpId || !topicId) {
    return { status: 400, body: { error: 'missing_params', message: 'prompt_hash, serp_id, and topic_id are required' } };
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
        topic_id: topicId,
        response: v.response,
        cited_pages: Array.isArray(v.sources) ? v.sources : [],
        mentioned_brands: (v.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
        date: v.date ?? null,
      },
    },
  };
}
