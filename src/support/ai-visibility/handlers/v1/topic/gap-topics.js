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
  GapTopicsRequestSchema,
  GapTopicsResponseSchema,
  GapTopicsTotalsRequestSchema,
  GapTopicsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import { TOPICS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  brandTarget,
  parseCompetitorDomainsList,
  responseFromGrpcError,
  buildRangeExpr,
  isValidVolume,
} from '../../../grpc-utils.js';

/** @type {import('@bufbuild/protobuf').JsonReadOptions} */
const FROM_JSON = { ignoreUnknownFields: true };

/** @type {import('@bufbuild/protobuf').JsonWriteOptions} */
const TO_JSON = { useProtoFieldName: false, alwaysEmitImplicit: true };

/* c8 ignore start */
function buildGapTopicsDimensionFilterQl(sp) {
  const q = sp.get('searchQuery');
  if (!q) {
    return '';
  }
  const escaped = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `topic CONTAINS "${escaped}"`;
}

/**
 * @returns {{ ok: true, metricFilterQl: string } | { ok: false, status: number, body: object }}
 */
function buildGapTopicsMetricFilterQl(sp) {
  const volFrom = sp.get('volumeFrom');
  const volTo = sp.get('volumeTo');
  if (!isValidVolume(volFrom) || !isValidVolume(volTo)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_volume',
        message: 'volumeFrom and volumeTo must be non-negative integers',
      },
    };
  }

  const volExpr = buildRangeExpr('volume', volFrom, volTo);
  return { ok: true, metricFilterQl: volExpr };
}

export async function handleGapTopics(sp, clients) {
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

  let listRequest;
  let totalsRequest;
  try {
    listRequest = fromJson(
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
      FROM_JSON,
    );

    totalsRequest = fromJson(
      GapTopicsTotalsRequestSchema,
      {
        country,
        llm: engine,
        target: { domain, name: domain },
        competitors: competitorDomains.map(brandTarget),
        dimension_filter_ql: dimensionFilterQl,
        metric_filter_ql: metricFilterResult.metricFilterQl,
      },
      FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid gap topics request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const [topicsMessage, totalsMessage] = await Promise.all([
      clients.topicClient.gapTopics(listRequest),
      clients.topicClient.gapTopicsTotals(totalsRequest),
    ]);

    const topicsJson = /** @type {{ topics?: object[] }} */ (
      toJson(GapTopicsResponseSchema, topicsMessage, TO_JSON)
    );
    const totalsJson = /** @type {{ totals?: object[] }} */ (
      toJson(GapTopicsTotalsResponseSchema, totalsMessage, TO_JSON)
    );

    return {
      status: 200,
      body: {
        data: topicsJson.topics ?? [],
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
