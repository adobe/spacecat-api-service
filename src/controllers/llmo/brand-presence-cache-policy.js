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
 * Cache-Control headers for Brand Presence GET responses.
 *
 * `private` keeps responses out of shared caches (Fastly/Varnish) — required because
 * requests carry an `Authorization: Bearer …` token. The browser's own private cache
 * still serves the response on reload within the freshness window, which is the goal.
 *
 * `stale-while-revalidate` lets the browser serve stale data instantly after `max-age`
 * expires while it asynchronously refreshes in the background — best UX for reload.
 *
 * Tiers:
 *  - taxonomyCacheHeaders: structural lookups that change rarely (filter dimensions,
 *    week ranges).
 *  - metricsCacheHeaders: aggregate brand-presence reads that backend recomputes on
 *    a schedule (stats, sentiment, competitor data, topic detail, etc.).
 *
 * Returned as fresh objects per call because `createResponse()` in
 * @adobe/spacecat-shared-http-utils mutates the headers it's given (e.g. to add
 * Content-Type). Sharing one frozen / live object across requests breaks or leaks.
 */

const TAXONOMY_CACHE_CONTROL = 'private, max-age=3600, stale-while-revalidate=86400';
const METRICS_CACHE_CONTROL = 'private, max-age=300, stale-while-revalidate=900';

export const taxonomyCacheHeaders = () => ({ 'Cache-Control': TAXONOMY_CACHE_CONTROL });
export const metricsCacheHeaders = () => ({ 'Cache-Control': METRICS_CACHE_CONTROL });
