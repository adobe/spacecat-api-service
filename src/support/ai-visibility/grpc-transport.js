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
import { createGrpcTransport, Http2SessionManager } from '@connectrpc/connect-node';
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
import {
  resolveSemrushCredential,
  getCachedToken,
} from './semrush-credential-resolver.js';

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

/**
 * Feature flag: resolve the Semrush credential per brand instead of using the single
 * process-wide shared client_credentials machine credential. DEFAULT OFF -- when off,
 * behavior is byte-identical to the historical shared-singleton path.
 */
const PER_BRAND_AUTH_FLAG = 'AI_VISIBILITY_PER_BRAND_AUTH_ENABLED';

function isPerBrandAuthEnabled(env) {
  const v = env?.[PER_BRAND_AUTH_FLAG];
  return v === true || v === 'true' || v === '1';
}

/**
 * Cache key for the shared (resolver-returned-null) credential under flag-on.
 * Resolved credential keys are namespaced ({@link credentialPoolKey}) so a
 * provider-supplied key can never collide with this sentinel.
 */
const SHARED_CREDENTIAL_KEY = '__shared__';

/** Namespace a resolved credential key so it can't collide with the shared sentinel. */
function credentialPoolKey(credentialKey) {
  return `credential:${credentialKey}`;
}

/** Default upper bound on distinct per-credential transports held at once. */
const DEFAULT_MAX_CLIENTS_CACHE_SIZE = 100;

/** Mutable so tests can exercise eviction without building 100 transports. */
let maxClientsCacheSize = DEFAULT_MAX_CLIENTS_CACHE_SIZE;

/**
 * Build the gRPC transport + all service clients around a single auth interceptor.
 * The transport options are identical across the shared and per-credential paths;
 * only the interceptor differs.
 *
 * Returns the client set together with the {@link Http2SessionManager} that owns the
 * transport's HTTP/2 connection, so an evicted per-credential entry can close its
 * connection instead of leaking it ({@link teardownClientPoolEntry}).
 *
 * @returns {{ clients: object, sessionManager: Http2SessionManager }}
 */
function buildClientPoolEntry(interceptor) {
  const sessionManager = new Http2SessionManager(GRPC_BASE_URL);
  const transport = createGrpcTransport({
    baseUrl: GRPC_BASE_URL,
    httpVersion: '2',
    interceptors: [interceptor],
    sessionManager,
  });

  const clients = {
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

  return { clients, sessionManager };
}

/**
 * Tear down a pool entry's transport: abort its HTTP/2 session manager so the
 * underlying connection is closed rather than leaked when the entry is evicted or the
 * pool is reset. No-op when the entry has no session manager (e.g. under test mocks).
 *
 * Best-effort: a failure to abort one entry must not stop teardown of the others (this
 * runs in an eviction loop and a `forEach` over the whole pool), so the error is
 * swallowed rather than propagated.
 */
function teardownClientPoolEntry(entry) {
  try {
    entry?.sessionManager?.abort?.();
  } catch {
    // Swallowed intentionally -- see the best-effort note above.
  }
}

/**
 * Auth interceptor for the per-credential path. When a credential descriptor is
 * resolved, tokens are minted through its `getAuthToken` and cached per credential
 * key with a TTL. When no credential is resolved (`credential == null`) it falls back
 * to the shared client_credentials token -- identical to {@link createAuthInterceptor}.
 */
function createCredentialInterceptor(env, credential) {
  return (next) => async (req) => {
    const token = credential
      ? await getCachedToken(credential.key, () => credential.getAuthToken(env))
      : await getAccessToken(env);
    req.header.set('authorization', `Bearer ${token}`);
    return next(req);
  };
}

let cachedEntry = null;

/** key -> pool entry ({ clients, sessionManager }), used only on the per-brand (flag-on) path. */
const perCredentialEntries = new Map();

/**
 * Lazy-init gRPC transport + all service clients.
 *
 * Flag OFF (default): reuses a singleton per process so multiple requests share the
 * same HTTP/2 connection pool, authenticating with the shared client_credentials
 * machine credential via {@link createAuthInterceptor}.
 *
 * Flag ON: resolves the credential for `brand` via the auth seam and keys a bounded
 * pool of transports per credential. Because no provider is configured by default,
 * the resolver returns `null` and this still falls back to the shared credential --
 * i.e. flag-on is inert until PR-3b injects a real provider.
 *
 * @param {object} env - request environment (secrets, config, feature flags).
 * @param {unknown} [brand] - brand/org scope (only consulted when the flag is on).
 */
export function getGrpcClients(env, brand) {
  if (!isPerBrandAuthEnabled(env)) {
    if (cachedEntry) {
      return cachedEntry.clients;
    }
    cachedEntry = buildClientPoolEntry(createAuthInterceptor(env));
    return cachedEntry.clients;
  }

  const credential = resolveSemrushCredential(brand, env);
  const key = credential
    ? credentialPoolKey(credential.key)
    : SHARED_CREDENTIAL_KEY;

  const existing = perCredentialEntries.get(key);
  if (existing) {
    return existing.clients;
  }

  // Bound the pool: evict the oldest (FIFO by build time) transport when at capacity,
  // tearing down its HTTP/2 session so the connection is closed rather than leaked.
  while (perCredentialEntries.size >= maxClientsCacheSize) {
    const oldestKey = perCredentialEntries.keys().next().value;
    teardownClientPoolEntry(perCredentialEntries.get(oldestKey));
    perCredentialEntries.delete(oldestKey);
  }

  const entry = buildClientPoolEntry(createCredentialInterceptor(env, credential));
  perCredentialEntries.set(key, entry);
  return entry.clients;
}

/** @visibleForTesting */
export function resetGrpcClients() {
  teardownClientPoolEntry(cachedEntry);
  cachedEntry = null;
  perCredentialEntries.forEach(teardownClientPoolEntry);
  perCredentialEntries.clear();
  maxClientsCacheSize = DEFAULT_MAX_CLIENTS_CACHE_SIZE;
}

/** @visibleForTesting */
export function setClientPoolMaxSize(n) {
  maxClientsCacheSize = n;
}

/** @visibleForTesting */
export function getClientPoolSize() {
  return perCredentialEntries.size;
}

export { getAccessToken, createAuthInterceptor };
