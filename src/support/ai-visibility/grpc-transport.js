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

import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { BrandService } from '@quazar/ai-seo-ts/v2/brand/service_pb.js';
import { TopicService } from '@quazar/ai-seo-ts/v2/topic/service_pb.js';
import { PromptService } from '@quazar/ai-seo-ts/v2/prompt/service_pb.js';
import { SourceService } from '@quazar/ai-seo-ts/v2/source/service_pb.js';
import { CompetitorService } from '@quazar/ai-seo-ts/v2/competitor/service_pb.js';
import {
  CompetitorsMetrics,
  Meta as CrMeta,
} from '@quazar/ai-seo-ts/ai-cr/service_pb.js';
import { Sources as VoSources } from '@quazar/ai-seo-ts/ai-vo/service_pb.js';
import { Relations } from '@quazar/ai-seo-ts/ai-pr/service_pb.js';

const DEFAULT_SCOPES = 'ai-seo.meta ai-seo.topics ai-seo.prompts ai-seo.sources ai-seo.brand-metrics ai-seo.relations ai-seo.competitors-metrics ai-seo.competitor';

const GRPC_BASE_URL = 'https://grpc-api.semrush.com';

function semrushAiSeoOAuthTokenUrl(env) {
  const u = env.SEO_OAUTH_TOKEN_URL?.trim();
  if (u) {
    return u;
  }
  const path = '/apis/v4-raw/auth/v0/oauth2/access_token';
  return new URL(path, 'https://api.semrush.com').href;
}

async function getAccessToken(env) {
  const id = env.SEO_CLIENT_ID;
  const secret = env.SEO_CLIENT_SECRET;
  if (!id?.trim() || !secret?.trim()) {
    throw new Error('SEO_CLIENT_ID and SEO_CLIENT_SECRET must be set');
  }
  const body = new URLSearchParams({
    client_id: id.trim(),
    client_secret: secret.trim(),
    scope: (env.SEO_OAUTH_SCOPES || DEFAULT_SCOPES).trim(),
    grant_type: 'client_credentials',
  });
  const r = await fetch(semrushAiSeoOAuthTokenUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.access_token) {
    const oauthErr = typeof j.error === 'string' ? j.error : '';
    // eslint-disable-next-line no-console
    console.error('Semrush OAuth token request failed', {
      httpStatus: r.status,
      oauthError: oauthErr,
    });
    throw new Error('Semrush OAuth token request failed');
  }
  return j.access_token;
}

function createAuthInterceptor(env) {
  return (next) => async (req) => {
    const token = await getAccessToken(env);
    req.header.set('authorization', `Bearer ${token}`);
    return next(req);
  };
}

let cachedClients = null;

/**
 * Lazy-init gRPC transport + all service clients.
 * Reuses a singleton per process so multiple requests share the same HTTP/2 connection pool.
 */
export function getGrpcClients(env) {
  if (cachedClients) {
    return cachedClients;
  }

  const transport = createGrpcTransport({
    baseUrl: GRPC_BASE_URL,
    httpVersion: '2',
    interceptors: [createAuthInterceptor(env)],
  });

  cachedClients = {
    brandClient: createClient(BrandService, transport),
    topicClient: createClient(TopicService, transport),
    promptClient: createClient(PromptService, transport),
    sourceClient: createClient(SourceService, transport),
    competitorClient: createClient(CompetitorService, transport),
    crMetricsClient: createClient(CompetitorsMetrics, transport),
    crMetaClient: createClient(CrMeta, transport),
    voSourcesClient: createClient(VoSources, transport),
    prRelationsClient: createClient(Relations, transport),
  };

  return cachedClients;
}

/** @visibleForTesting */
export function resetGrpcClients() {
  cachedClients = null;
}

export { getAccessToken, createAuthInterceptor };
