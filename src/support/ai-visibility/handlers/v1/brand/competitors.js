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
  BrandCompetitorsRequestSchema,
  BrandCompetitorsResponseSchema,
} from '@quazar/ai-seo-ts/v2/competitor/messages_pb.js';
import {
  PROTO_FROM_JSON,
  PROTO_TO_JSON,
  responseFromGrpcError,
} from '../../../grpc-utils.js';

/* c8 ignore start */
export async function handleCompetitors(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) {
    return {
      status: 400,
      body: { error: 'invalid_request', message: 'domain is required' },
    };
  }
  const count = sp.get('count');

  let request;
  try {
    request = fromJson(
      BrandCompetitorsRequestSchema,
      {
        target: { domain, name: domain },
        ...(count ? { count } : {}),
      },
      PROTO_FROM_JSON,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid competitors request';
    return {
      status: 400,
      body: { error: 'invalid_request', message },
    };
  }

  try {
    const response = await clients.competitorClient.brandCompetitors(request);
    return {
      status: 200,
      body: toJson(BrandCompetitorsResponseSchema, response, PROTO_TO_JSON),
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
