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
  EXPORT_FILE_FORMAT_ENUM,
  ExportResponseSchema,
} from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import {
  GapTopicsExportRequestSchema,
  GapTopicsRequestSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import { TOPICS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
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
import {
  buildGapTopicsDimensionFilterQl,
  buildGapTopicsMetricFilterQl,
} from './gap-topics.js';

/* c8 ignore start */
export async function handleGapTopicsExport(sp, clients) {
  const domain = sp.get('domain');
  const competitorDomains = parseCompetitorDomainsList(sp);
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || TOPICS_REQUEST_ORDER_BY_ENUM.TOTAL_COMPETITOR_MENTIONS;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const { limit, offset } = parseLimitOffset(sp);

  const gapKindsRaw = sp.get('gapKinds');
  const kinds = gapKindsRaw ? gapKindsRaw.split(',') : [GAP_KIND_ENUM.ALL];

  const dimensionFilterQl = buildGapTopicsDimensionFilterQl(sp);
  const metricFilterResult = buildGapTopicsMetricFilterQl(sp);
  if (!metricFilterResult.ok) {
    return { status: metricFilterResult.status, body: metricFilterResult.body };
  }

  let exportRequest;
  try {
    const topicsRequest = fromJson(
      GapTopicsRequestSchema,
      {
        country,
        llm: engine,
        target: { domain, name: domain },
        competitors: competitorDomains.map(brandTarget),
        kind: kinds,
        order: {
          by: sortBy,
          direction: sortDirection,
        },
        range: { limit, offset },
        dimension_filter_ql: dimensionFilterQl,
        metric_filter_ql: metricFilterResult.metricFilterQl,
      },
      PROTO_FROM_JSON,
    );

    exportRequest = fromJson(
      GapTopicsExportRequestSchema,
      {
        request: topicsRequest,
        format: EXPORT_FILE_FORMAT_ENUM.CSV,
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid gap topics export request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const exportMessage = await clients.topicClient.gapTopicsExport(exportRequest);

    return {
      status: 200,
      body: toJson(ExportResponseSchema, exportMessage, PROTO_TO_JSON),
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
