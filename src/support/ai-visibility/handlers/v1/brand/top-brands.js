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
import { COUNTRY_ENUM, LLM_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  TopBrandsByDomainRequestSchema,
  TopBrandsByDomainResponseSchema,
} from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import {
  engineToLlm,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
  resolveCountry,
  responseFromGrpcError,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export async function handleTopBrands(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) {
    return {
      status: 400,
      body: { error: 'invalid_request', message: 'domain is required' },
    };
  }
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const llm = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const limit = sp.get('limit') || '10';

  let request;
  try {
    request = fromJson(
      TopBrandsByDomainRequestSchema,
      {
        country,
        brand_domain: domain.replace(/^www\./i, '').toLowerCase(),
        llm,
        limit,
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid top brands request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const response = await clients.brandClient.topBrandsByDomain(request);
    return {
      status: 200,
      body: toJson(TopBrandsByDomainResponseSchema, response, PROTO_TO_JSON),
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
