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

import { Response as AdobeFetchResponse } from '@adobe/fetch';

/**
 * Defensive outermost wrapper that guarantees the response reaching
 * `@adobe/helix-universal`'s AWS Lambda adapter is an `@adobe/fetch`-compatible
 * Response.
 *
 * WHY THIS EXISTS
 * ---------------
 * The AWS adapter serializes the outbound response by calling
 * `response.headers.raw()` (helix-universal `aws-adapter.js:254`). That method
 * exists on `@adobe/fetch`'s `Headers` (a `node-fetch` v2 compatible shim) but
 * NOT on the standard Web-Fetch-API `Headers` (the `undici` implementation
 * bundled by esbuild alongside `@adobe/fetch`). If any code path in the
 * wrapper chain returns a native Response instance, the adapter throws
 * `TypeError: response.headers.raw is not a function` and every request on
 * that path 500s.
 *
 * The regression was hit after SITES-48140 added `metrics-emf` imports to
 * `RedirectsController` and `AsoOverlayKeyHandler`. Both `createResponse`
 * (via `@adobe/spacecat-shared-http-utils`) and `authWrapper` correctly
 * construct `@adobe/fetch` Responses at the SOURCE level — verified by a
 * standalone local test — but the esbuild bundle produced by `helix-deploy`
 * exposes two Response classes (the `@adobe/fetch` one AND the undici one)
 * and something in the extended import graph now returns the undici Response
 * from a code path that previously returned the `@adobe/fetch` one. Rather
 * than chase the exact module resolution behavior (which is opaque and
 * fragile), we normalize at the outermost seam.
 *
 * WHAT IT DOES
 * ------------
 * If the response reaching us already has `headers.raw` (already an
 * `@adobe/fetch` Response), pass it through unchanged. Otherwise, rebuild
 * it as an `@adobe/fetch` Response with the same status, headers, and body.
 * All response bodies in this service are small text/JSON overlays — buffering
 * to `arrayBuffer()` before rewrap is safe and non-streaming.
 *
 * MUST BE THE OUTERMOST WRAPPER
 * -----------------------------
 * Install this LAST in the `.with(...)` chain (which means it runs FIRST on
 * the response path — helix-shared-wrap execution order is
 * outermost-runs-first) so it sees whatever every downstream wrapper produced
 * and hands the AWS adapter a guaranteed-compatible Response.
 */
export function ensureFetchResponseWrapper(fn) {
  return async (request, context) => {
    const response = await fn(request, context);
    if (!response || typeof response !== 'object') {
      return response;
    }
    // Fast path: already an @adobe/fetch Response (has Headers with .raw()).
    // Guard on `.headers` because some non-HTTP handlers may return raw
    // objects that helix-universal passes through untouched.
    if (response.headers && typeof response.headers.raw === 'function') {
      return response;
    }
    // Slow path: rebuild as @adobe/fetch Response. Buffer the body (all
    // responses in this service are small) so the wrap is synchronous from
    // the caller's perspective.
    const bodyBuffer = await response.arrayBuffer();
    const headersObj = {};
    if (response.headers && typeof response.headers.forEach === 'function') {
      response.headers.forEach((value, name) => {
        headersObj[name] = value;
      });
    }
    return new AdobeFetchResponse(Buffer.from(bodyBuffer), {
      status: response.status,
      headers: headersObj,
    });
  };
}
