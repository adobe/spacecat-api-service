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
  BrandTopicsRequestSchema,
  BrandTopicsResponseSchema,
  BrandTopicsTotalsRequestSchema,
  BrandTopicsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import {
  BRAND_TOPICS_ORDER_BY_ENUM,
  PROMPT_CATEGORY_ENUM,
} from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  responseFromGrpcError,
} from '../../../grpc-utils.js';

/** @type {import('@bufbuild/protobuf').JsonReadOptions} */
const FROM_JSON = { ignoreUnknownFields: true };

/** @type {import('@bufbuild/protobuf').JsonWriteOptions} */
const TO_JSON = { useProtoFieldName: false, alwaysEmitImplicit: true };

/* c8 ignore start */
export async function handleBrandTopics(sp, clients) {
  const domain = sp.get('domain');
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || BRAND_TOPICS_ORDER_BY_ENUM.VISIBILITY;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const { limit, offset } = parseLimitOffset(sp);

  const categories = [
    PROMPT_CATEGORY_ENUM.MENTIONS_TARGET,
    PROMPT_CATEGORY_ENUM.CITES_TARGET,
  ];

  const listRequest = fromJson(
    BrandTopicsRequestSchema,
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
    },
    FROM_JSON,
  );

  const totalsRequest = fromJson(
    BrandTopicsTotalsRequestSchema,
    {
      country,
      llm: engine,
      target: { domain, name: domain },
      categories,
    },
    FROM_JSON,
  );

  try {
    const [topicsMessage, totalsMessage] = await Promise.all([
      clients.topicClient.brandTopics(listRequest),
      clients.topicClient.brandTopicsTotals(totalsRequest),
    ]);

    const topicsJson = /** @type {{ topics?: object[] }} */ (
      toJson(BrandTopicsResponseSchema, topicsMessage, TO_JSON)
    );
    const totalsJson = /** @type {{ total?: string|number }} */ (
      toJson(BrandTopicsTotalsResponseSchema, totalsMessage, TO_JSON)
    );

    return {
      status: 200,
      body: {
        data: topicsJson.topics ?? [],
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
