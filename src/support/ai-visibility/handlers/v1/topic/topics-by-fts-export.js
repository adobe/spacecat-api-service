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
import {
  COUNTRY_ENUM,
  LLM_ENUM,
  ORDER_DIRECTION_ENUM,
} from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  EXPORT_FILE_FORMAT_ENUM,
  ExportResponseSchema,
} from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import {
  TopicsByFTSExportRequestSchema,
  TopicsByFTSRequestSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import { TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import {
  parseLimitOffset,
  engineToLlm,
  resolveCountry,
  responseFromGrpcError,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';
import { buildTopicsByFtsDimensionFilterQl } from './topics-by-fts.js';

export async function handleTopicsByFtsExport(sp, clients) {
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const { limit, offset } = parseLimitOffset(sp);
  const dimensionFilterQl = buildTopicsByFtsDimensionFilterQl(sp);
  let request;
  try {
    const listRequest = fromJson(TopicsByFTSRequestSchema, {
      country,
      llm: engine,
      query: sp.get('query'),
      order: {
        by: sp.get('sortBy') || TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.RELEVANCE_SCORE,
        direction: sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC,
      },
      range: { limit, offset },
      dimensionFilterQl,
    }, PROTO_FROM_JSON);
    request = fromJson(TopicsByFTSExportRequestSchema, {
      request: listRequest,
      format: EXPORT_FILE_FORMAT_ENUM.CSV,
    }, PROTO_FROM_JSON);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid topics by FTS export request';
    return { status: 400, body: { error: 'invalid_request', message } };
  }
  try {
    const response = await clients.topicClient.topicsByFTSExport(request);
    return { status: 200, body: toJson(ExportResponseSchema, response, PROTO_TO_JSON) };
  } catch (error) {
    const mapped = responseFromGrpcError(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}
/* c8 ignore stop */
