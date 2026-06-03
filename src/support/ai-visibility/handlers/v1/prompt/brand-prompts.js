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
} from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  PromptsRequestSchema,
  PromptsResponseSchema,
  PromptsTotalsRequestSchema,
  PromptsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import {
  PROMPT_CATEGORY_ENUM,
  PROMPTS_REQUEST_ORDER_BY_ENUM,
} from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export async function handleBrandPrompts(sp, clients) {
  const domain = sp.get('domain');
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const sortBy = sp.get('sortBy') || PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const topicId = sp.get('topicId');
  const date = sp.get('date');
  const { limit, offset } = parseLimitOffset(sp);

  const categories = [
    PROMPT_CATEGORY_ENUM.MENTIONS_TARGET,
    PROMPT_CATEGORY_ENUM.CITES_TARGET,
  ];

  const listRequest = fromJson(
    PromptsRequestSchema,
    {
      country,
      llm: engine,
      target: { domain, name: domain },
      order: {
        by: sortBy,
        direction: sortDirection,
      },
      range: { limit, offset },
      categories,
      dimension_filter_ql: topicId ? `topic_hash = ${topicId}` : '',
      target_date: date,
    },
    PROTO_FROM_JSON,
  );

  const totalsRequest = fromJson(
    PromptsTotalsRequestSchema,
    {
      country,
      llm: engine,
      target: { domain, name: domain },
      categories,
      dimension_filter_ql: topicId ? `topic_hash = ${topicId}` : '',
      target_date: date,
    },
    PROTO_FROM_JSON,
  );

  try {
    const [promptsMessage, totalsMessage] = await Promise.all([
      clients.promptClient.prompts(listRequest),
      clients.promptClient.promptsTotals(totalsRequest),
    ]);

    const promptsJson = /** @type {{ prompts?: object[] }} */ (
      toJson(PromptsResponseSchema, promptsMessage, PROTO_TO_JSON)
    );
    const totalsJson = /** @type {{ total?: string|number }} */ (
      toJson(PromptsTotalsResponseSchema, totalsMessage, PROTO_TO_JSON)
    );

    return {
      status: 200,
      body: {
        data: promptsJson.prompts ?? [],
        total: totalsJson.total ?? 0,
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
