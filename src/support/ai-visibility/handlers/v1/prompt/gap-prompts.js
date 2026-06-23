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

import { fromJson, toJson } from '@bufbuild/protobuf';
import {
  COUNTRY_ENUM,
  LLM_ENUM,
  ORDER_DIRECTION_ENUM,
  GAP_KIND_ENUM,
} from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  GapPromptsRequestSchema,
  GapPromptsResponseSchema,
  GapPromptsTotalsRequestSchema,
  GapPromptsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import { GAP_PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  brandTarget,
  parseCompetitorDomainsList,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export async function handleGapPrompts(sp, clients) {
  const domain = sp.get('domain');
  const competitorDomains = parseCompetitorDomainsList(sp);
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || GAP_PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const { limit, offset } = parseLimitOffset(sp);

  const gapKindsRaw = sp.get('gapKinds');
  const kinds = gapKindsRaw ? gapKindsRaw.split(',') : [GAP_KIND_ENUM.ALL];

  const topicId = sp.get('topicId');
  const sourceDomain = sp.get('sourceDomain');
  const date = sp.get('date');

  let listRequest;
  let totalsRequest;
  try {
    const listJson = {
      country,
      llm: engine,
      target: { domain, name: domain },
      competitors: competitorDomains.map(brandTarget),
      kinds,
      order: {
        by: sortBy,
        direction: sortDirection,
      },
      range: { limit, offset },
      target_date: date,
    };
    if (topicId) {
      listJson.topic_hash = topicId;
    }
    if (sourceDomain) {
      listJson.source_domain = sourceDomain;
    }
    listRequest = fromJson(GapPromptsRequestSchema, listJson, PROTO_FROM_JSON);

    const totalsJson = {
      country,
      llm: engine,
      target: { domain, name: domain },
      competitors: competitorDomains.map(brandTarget),
      target_date: date,
    };
    if (topicId) {
      totalsJson.topic_hash = topicId;
    }
    if (sourceDomain) {
      totalsJson.source_domain = sourceDomain;
    }
    totalsRequest = fromJson(GapPromptsTotalsRequestSchema, totalsJson, PROTO_FROM_JSON);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid gap prompts request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const [promptsMessage, totalsMessage] = await Promise.all([
      clients.promptClient.gapPrompts(listRequest),
      clients.promptClient.gapPromptsTotals(totalsRequest),
    ]);

    const promptsJson = /** @type {{ prompts?: object[] }} */ (
      toJson(GapPromptsResponseSchema, promptsMessage, PROTO_TO_JSON)
    );
    const totalsJson = /** @type {{ totals?: object[] }} */ (
      toJson(GapPromptsTotalsResponseSchema, totalsMessage, PROTO_TO_JSON)
    );

    return {
      status: 200,
      body: {
        data: promptsJson.prompts ?? [],
        totals: totalsJson.totals ?? [],
      },
    };
  } catch (error) {
    const mapped = responseFromGrpcError(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}
/* c8 ignore stop */
