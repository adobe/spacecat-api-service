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
  GapSourceDomainsRequestSchema,
  GapSourceDomainsResponseSchema,
} from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import { DOMAINS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  brandTarget,
  parseCompetitorDomainsList,
  responseFromGrpcError,
  escapeQlString,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export function buildGapSourceDomainsDimensionFilterQl(sp) {
  const q = sp.get('searchQuery');
  if (!q) {
    return '';
  }
  return `domain CONTAINS "${escapeQlString(q)}"`;
}

export async function handleGapSourceDomains(sp, clients) {
  const domain = sp.get('domain');
  const competitorDomains = parseCompetitorDomainsList(sp);
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || DOMAINS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const date = sp.get('date');
  const { limit, offset } = parseLimitOffset(sp);

  const gapKindsRaw = sp.get('gapKinds');
  const kinds = gapKindsRaw ? gapKindsRaw.split(',') : [GAP_KIND_ENUM.ALL];

  const dimensionFilterQl = buildGapSourceDomainsDimensionFilterQl(sp);

  let listRequest;
  try {
    listRequest = fromJson(
      GapSourceDomainsRequestSchema,
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
        target_date: date,
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid gap source domains request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const domainsMessage = await clients.sourceClient.gapSourceDomains(listRequest);

    const domainsJson = /** @type {{ domains?: object[] }} */ (
      toJson(GapSourceDomainsResponseSchema, domainsMessage, PROTO_TO_JSON)
    );

    return {
      status: 200,
      body: {
        data: domainsJson.domains ?? [],
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
