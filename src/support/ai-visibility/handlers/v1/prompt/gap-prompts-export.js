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
  GapPromptsExportRequestSchema,
  GapPromptsRequestSchema,
} from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import { GAP_PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
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

/* c8 ignore start */
export async function handleGapPromptsExport(sp, clients) {
  const domain = sp.get('domain');
  const competitorDomains = parseCompetitorDomainsList(sp);
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.WORLDWIDE;
  const sortBy = sp.get('sortBy') || GAP_PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT;
  const sortDirection = sp.get('sortDirection') || ORDER_DIRECTION_ENUM.DESC;
  const { limit, offset } = parseLimitOffset(sp);

  const gapKindsRaw = sp.get('gapKinds');
  const kinds = gapKindsRaw ? gapKindsRaw.split(',') : [GAP_KIND_ENUM.ALL];

  const topicId = sp.get('topicId');
  const sourceDomain = sp.get('sourceDomain');

  let exportRequest;
  try {
    const gapPromptsJson = {
      country,
      llm: engine,
      target: { domain, name: domain },
      competitors: competitorDomains.map(brandTarget),
      kinds,
      order: {
        by: sortBy,
        direction: sortDirection,
      },
      range: { limit, offset },
    };
    if (topicId) {
      gapPromptsJson.topic_hash = topicId;
    }
    if (sourceDomain) {
      gapPromptsJson.source_domain = sourceDomain;
    }

    const gapPromptsRequest = fromJson(
      GapPromptsRequestSchema,
      gapPromptsJson,
      PROTO_FROM_JSON,
    );
    exportRequest = fromJson(
      GapPromptsExportRequestSchema,
      {
        request: gapPromptsRequest,
        format: EXPORT_FILE_FORMAT_ENUM.CSV,
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid gap prompts export request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const exportMessage = await clients.promptClient.gapPromptsExport(exportRequest);

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
