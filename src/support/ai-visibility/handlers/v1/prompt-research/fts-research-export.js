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
import { ORDER_DIRECTION_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import {
  EXPORT_FILE_FORMAT_ENUM,
  ExportResponseSchema,
} from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import {
  parseLimitOffset,
  resolveCountryForFts,
  requiredLlmFromQuery,
  responseFromGrpcError,
  buildTextFilterQl,
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
} from '../../../grpc-utils.js';

/**
 * Shared runner for the Prompt Research CSV export endpoints (prompts, brands,
 * source-domains, topics). Each of these mirrors its `/topics/research/*` list
 * handler but returns a server-generated CSV (base64) the UI pages and stitches.
 *
 * The FTS request shape is identical across the four datasets
 * (`country / llm / query / order / range`), so only the proto schemas, the
 * sortBy map and the gRPC export method differ per dataset.
 *
 * Engine handling: when no `engine` is supplied (the default "All engines"
 * view) `requiredLlmFromQuery` returns `LLM_ENUM.ALL`, and SR returns rows for
 * every engine in a single call (verified against the prompts FTS export — the
 * `llm` column spans chatgpt/gemini/google_ai_mode/google_ai_overview). So no
 * per-engine fan-out is needed here, unlike the paginated list handlers.
 *
 * @param {URLSearchParams} sp request search params
 * @param {object} clients gRPC clients
 * @param {object} config dataset-specific wiring
 * @param {import('@bufbuild/protobuf').GenMessage} config.requestSchema FTS request schema
 * @param {import('@bufbuild/protobuf').GenMessage} config.exportSchema FTS export-request schema
 * @param {Record<string, number>} config.sortMap allowed sortBy keys -> order-by enum
 * @param {string} config.defaultSortKey default sortBy key
 * @param {(clients: object, exportRequest: object) => Promise<object>} config.callExport gRPC call
 * @param {string} config.label human-readable dataset label for error messages
 * @param {string} config.textFilterColumn dimension column for the optional `textFilter` search
 */
/* c8 ignore start */
export async function runFtsResearchExport(sp, clients, config) {
  const {
    requestSchema, exportSchema, sortMap, defaultSortKey, callExport, label, textFilterColumn,
  } = config;

  const searchQuery = sp.get('searchQuery')?.trim();
  if (!searchQuery) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }

  const rawSortBy = sp.get('sortBy');
  if (rawSortBy && !Object.prototype.hasOwnProperty.call(sortMap, rawSortBy)) {
    return {
      status: 400,
      body: {
        error: 'invalid_sort_by',
        message: `sortBy must be one of: ${Object.keys(sortMap).join(', ')}`,
      },
    };
  }
  const rawDir = sp.get('sortDirection');
  if (rawDir && rawDir !== 'ASC' && rawDir !== 'DESC') {
    return {
      status: 400,
      body: { error: 'invalid_sort_direction', message: 'sortDirection must be ASC or DESC' },
    };
  }

  const sortBy = sortMap[rawSortBy || defaultSortKey];
  const sortDirection = rawDir === 'ASC' ? ORDER_DIRECTION_ENUM.ASC : ORDER_DIRECTION_ENUM.DESC;
  const country = resolveCountryForFts(sp);
  const llm = requiredLlmFromQuery(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const dimensionFilterQl = buildTextFilterQl(sp.get('textFilter'), textFilterColumn);

  let exportRequest;
  try {
    const request = fromJson(
      requestSchema,
      {
        country,
        llm,
        query: searchQuery,
        order: { by: sortBy, direction: sortDirection },
        range: { limit, offset },
        ...(dimensionFilterQl ? { dimensionFilterQl } : {}),
      },
      PROTO_FROM_JSON,
    );
    exportRequest = fromJson(
      exportSchema,
      { request, format: EXPORT_FILE_FORMAT_ENUM.CSV },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : `Invalid ${label} export request`;
    return { status: 400, body: { error: 'invalid_request', message } };
  }

  try {
    const exportMessage = await callExport(clients, exportRequest);
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
