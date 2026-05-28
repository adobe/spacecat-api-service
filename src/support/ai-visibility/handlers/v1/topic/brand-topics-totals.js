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
} from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  BrandTopicsTotalsRequestSchema,
  BrandTopicsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import {
  PROMPT_CATEGORY_ENUM,
} from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import {
  resolveCountry,
  engineToLlm,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';
import {
  buildBrandTopicsDimensionFilterQl,
  buildBrandTopicsMetricFilterQl,
} from './brand-topics.js';

/* c8 ignore start */
export async function handleBrandTopicsTotals(sp, clients) {
  const domain = sp.get('domain');
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;

  const dimensionFilterQl = buildBrandTopicsDimensionFilterQl(sp);
  const metricFilterResult = buildBrandTopicsMetricFilterQl(sp);
  if (!metricFilterResult.ok) {
    return { status: metricFilterResult.status, body: metricFilterResult.body };
  }
  const { metricFilterQl } = metricFilterResult;

  const categories = [
    PROMPT_CATEGORY_ENUM.MENTIONS_TARGET,
    PROMPT_CATEGORY_ENUM.CITES_TARGET,
  ];

  const totalsRequest = fromJson(
    BrandTopicsTotalsRequestSchema,
    {
      country,
      llm: engine,
      target: { domain, name: domain },
      categories,
      dimension_filter_ql: dimensionFilterQl,
      metric_filter_ql: metricFilterQl,
    },
    PROTO_FROM_JSON,
  );

  try {
    const totalsMessage = await clients.topicClient.brandTopicsTotals(totalsRequest);

    const totalsJson = /** @type {{ total?: string|number }} */ (
      toJson(BrandTopicsTotalsResponseSchema, totalsMessage, PROTO_TO_JSON)
    );

    return {
      status: 200,
      body: {
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
