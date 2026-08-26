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

/**
 * Semrush AI Visibility "brands/topics/stats" client (`SEMRUSH_API_URL` +
 * `SEMRUSH_API_KEY`). VERIFIED live (2026-08-26): auth is the raw key as the
 * `Authorization` header value — NOT `Bearer <key>`, NOT a query param — confirmed by a
 * working curl example against the real endpoint. Not publicly documented (no hits in
 * Semrush's public API docs/KB), so this client is deliberately narrow (one endpoint,
 * one response shape) rather than a general Semrush SDK.
 *
 * Real response shape (`GET {SEMRUSH_API_URL}?domain=&country=&month=&engine=`):
 *   { meta: { success, status_code }, data: [ { topic_id, topic, topic_volume,
 *     responses, mentions, cited_pages }, ... ] }
 * `engine` is one of `chatgpt` | `gemini` | `google_ai_mode` | `google_ai_overview` —
 * confirmed to return meaningfully different topics AND volumes per engine for the same
 * domain/month (e.g. `google_ai_overview` topic_volume ~338k vs `gemini` ~1.8k for the
 * same top Lovesac topic), so callers must NOT default/merge across engines.
 */

/**
 * @param {{domain: string, country: string, month: string, engine: string}} params
 * @param {Record<string, string>} env
 * @param {{error: Function, warn: Function}} log
 * @returns {Promise<{ok: true, topics: object[]} | {ok: false, status: number, message: string}>}
 */
export async function fetchSemrushTopicsStats({
  domain, country, month, engine,
}, env, log) {
  const baseUrl = env?.SEMRUSH_API_URL;
  const apiKey = env?.SEMRUSH_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, status: 500, message: 'SEMRUSH_API_URL/SEMRUSH_API_KEY are not configured' };
  }

  const query = new URLSearchParams({
    domain, country, month, engine,
  });
  const url = `${baseUrl}?${query.toString()}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    log.error(`[semrush] request failed for domain=${domain} engine=${engine}`, error);
    return { ok: false, status: 502, message: 'Failed to reach the Semrush API' };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 502, message: 'Malformed response from the Semrush API' };
  }

  if (!response.ok || body?.meta?.success !== true) {
    log.warn(`[semrush] status=${response.status} domain=${domain} engine=${engine}`);
    const message = typeof body?.error?.message === 'string' ? body.error.message : 'Semrush request failed';
    return { ok: false, status: response.status, message };
  }

  return { ok: true, topics: Array.isArray(body.data) ? body.data : [] };
}
