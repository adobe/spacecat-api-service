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
  SourceDomainsRequestSchema,
  SourceDomainsResponseSchema,
} from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import { DOMAINS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  parseLimitOffset,
  resolveCountry,
  engineToLlm,
  responseFromGrpcError,
  escapeQlString,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export function buildCitedSourcesDimensionFilterQl(sp) {
  const query = sp.get('searchQuery');
  if (!query) {
    return '';
  }
  return `domain CONTAINS "${escapeQlString(query)}"`;
}

export async function handleCitedSources(sp, clients) {
  const domain = sp.get('domain');
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || DOMAINS_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const { limit, offset } = parseLimitOffset(sp);

  let listRequest;
  try {
    listRequest = fromJson(
      SourceDomainsRequestSchema,
      {
        country,
        llm: engine,
        target: { domain, name: domain },
        order: {
          by: sortBy,
          direction: sortDirection,
        },
        range: { limit, offset },
        dimension_filter_ql: buildCitedSourcesDimensionFilterQl(sp),
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid cited sources request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const domainsMessage = await clients.sourceClient.sourceDomains(listRequest);
    const domainsJson = /** @type {{ domains?: object[] }} */ (
      toJson(SourceDomainsResponseSchema, domainsMessage, PROTO_TO_JSON)
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
