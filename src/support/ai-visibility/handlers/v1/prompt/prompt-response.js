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
  PromptRequestSchema,
  PromptResponseSchema,
} from '@quazar/ai-seo-ts/ai-pr/messages_pb.js';
import {
  resolveCountry,
  engineToLlm,
  responseFromGrpcError,
} from '../../../grpc-utils.js';

/** @type {import('@bufbuild/protobuf').JsonReadOptions} */
const FROM_JSON = { ignoreUnknownFields: true };

/** @type {import('@bufbuild/protobuf').JsonWriteOptions} */
const TO_JSON = { useProtoFieldName: false, alwaysEmitImplicit: true };

/* c8 ignore start */
export async function handlePromptResponse(sp, clients) {
  const engine = engineToLlm(sp.get('engine')) || LLM_ENUM.ALL;
  const country = resolveCountry(sp) || COUNTRY_ENUM.US;
  const topicId = sp.get('topicId');
  const promptHash = sp.get('promptHash');
  const serpId = sp.get('serpId');

  let promptResponseRequest;
  try {
    promptResponseRequest = fromJson(
      PromptRequestSchema,
      {
        country,
        llm: engine,
        prompt_hash: promptHash,
        serp_id: serpId,
        topic_id: topicId,
      },
      FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid prompt request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const promptsMessage = await clients.prRelationsClient.prompt(
      promptResponseRequest,
    );

    /** @type {{ value?: object, sourcesWithTitles?: object[] }} */
    const promptsResponseJson = toJson(
      PromptResponseSchema,
      promptsMessage,
      TO_JSON,
    );

    return {
      status: 200,
      body: promptsResponseJson,
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
