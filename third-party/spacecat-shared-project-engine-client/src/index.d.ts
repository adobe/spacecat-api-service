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

import type { Client } from 'openapi-fetch';
import type { paths, components } from './generated/types.js';

/** Supplies the caller's IMS JWT — forwarded verbatim, never minted or exchanged. */
export type AuthTokenSource = string | (() => string | Promise<string>);

/**
 * A fully-typed Project Engine client over every operation in the generated `paths`.
 * The generated `paths` are already free of the legacy `Auth-Data-Jwt` header (the live API
 * authenticates on `Authorization: Bearer`), so no runtime header narrowing is required here.
 */
export type SerenityProjectEngineApiClient = Client<paths>;

export interface SerenityProjectEngineApiClientOptions {
  /**
   * Base URL of the Project Engine API — the origin of `SEMRUSH_PROJECTS_BASE_URL`, or the
   * Counterfact mock's origin for E2E / local dev. Only `protocol//host` is used; the client
   * appends the fixed `/enterprise/projects/api` prefix itself.
   */
  baseUrl: string;
  /**
   * The caller's IMS JWT, or a (sync/async) getter resolved per request. Sent as the
   * `Authorization: Bearer <token>` header. The client performs NO token exchange or minting —
   * Semrush accepts the IMS bearer token directly, so the caller's token is forwarded as-is.
   */
  authToken: AuthTokenSource;
  /** Retry attempts on 429 / retryable 5xx / network error. Default 2 (3 tries total). */
  maxRetries?: number;
  /** Base backoff in ms; grows exponentially per attempt. Default 200. */
  retryBaseDelayMs?: number;
  /**
   * Best-effort hook invoked before each retry sleep, for logging/metrics. A retry loop is
   * otherwise silent. A throwing or rejecting hook is swallowed and never affects the request.
   * May be async; it is fire-and-forget (never awaited) so it cannot delay a retry.
   */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    method: string;
    status?: number;
    error?: Error;
  }) => void | Promise<void>;
  /** Injectable fetch (tests, custom agents). Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Creates a thin, typed client over the generated Project Engine `paths`. It owns the base
 * URL (origin + `/enterprise/projects/api`), retries, and authenticating each request with the
 * caller's IMS JWT as `Authorization: Bearer` — and nothing else; request/response shapes come
 * straight from the generated types.
 */
export declare function createSerenityProjectEngineApiClient(
  options: SerenityProjectEngineApiClientOptions,
): SerenityProjectEngineApiClient;

// Re-export the generated contract types for consumers that want them directly.
export type { paths, components };
