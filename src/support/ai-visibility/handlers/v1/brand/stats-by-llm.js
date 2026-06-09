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

/* c8 ignore start */

import { fromJson, toJson } from '@bufbuild/protobuf';
import { COUNTRY_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  StatsByLLMRequestSchema,
  StatsByLLMResponseSchema,
} from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import {
  resolveCountry,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

export async function handleStatsByLLM(sp, clients) {
  const domain = sp.get('domain');
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  let statsRequest;
  try {
    statsRequest = fromJson(
      StatsByLLMRequestSchema,
      {
        country,
        target: { domain, name: domain },
        date_from: dateFrom,
        date_to: dateTo,
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid stats by LLM request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const statsMessage = await clients.brandClient.statsByLLM(statsRequest);

    const statsJson = toJson(
      StatsByLLMResponseSchema,
      statsMessage,
      PROTO_TO_JSON,
    );

    return {
      status: 200,
      body: statsJson,
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
/* c8 ignore end */
