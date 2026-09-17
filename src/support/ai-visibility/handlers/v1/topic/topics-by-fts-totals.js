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
import { COUNTRY_ENUM, LLM_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  TopicsByFTSTotalsRequestSchema,
  TopicsByFTSTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import {
  engineToLlm,
  resolveCountry,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';
import { buildTopicsByFtsDimensionFilterQl } from './topics-by-fts.js';

export async function handleTopicsByFtsTotals(sp, clients) {
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const dimensionFilterQl = buildTopicsByFtsDimensionFilterQl(sp);
  let request;
  try {
    request = fromJson(TopicsByFTSTotalsRequestSchema, {
      country,
      llm: engine,
      query: sp.get('query'),
      dimensionFilterQl,
    }, PROTO_FROM_JSON);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid topics by FTS totals request';
    return { status: 400, body: { error: 'invalid_request', message } };
  }
  try {
    const response = await clients.topicClient.topicsByFTSTotals(request);
    return {
      status: 200,
      body: toJson(TopicsByFTSTotalsResponseSchema, response, PROTO_TO_JSON),
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
