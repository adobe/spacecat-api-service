/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import facsCapabilities from '../../../src/routes/facs-capabilities.js';

/**
 * Builds per-product route matchers from facs-capabilities.js so the test
 * http-client can default `x-product` to the product whose sub-map claims
 * the URL being requested. This keeps the IT-postgres tests in sync with
 * the strict fail-closed contract in facsWrapper: a request for a route
 * in some product's sub-map must declare that product via x-product.
 *
 * The matchers are precomputed once at module load — order-of-magnitude
 * 100 routes per product; negligible per-request cost in tests.
 */
const PRODUCT_MATCHERS = (() => {
  const out = [];
  for (const [productCode, subMap] of Object.entries(facsCapabilities.PRODUCTS_ROUTES || {})) {
    if (subMap && Object.keys(subMap).length > 0) {
      for (const key of Object.keys(subMap)) {
        const [method, pattern] = key.split(' ');
        // Convert `/sites/:siteId/audits/:auditType` → `^/sites/[^/]+/audits/[^/]+$`.
        const regex = new RegExp(
          `^${pattern.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, '[^/]+').replace(/\//g, '\\/')}$`,
        );
        out.push({ productCode, method: method.toUpperCase(), regex });
      }
    }
  }
  return out;
})();

/**
 * Returns the upper-cased product code that claims `method path` per
 * `PRODUCTS_ROUTES`, or `null` when no product's sub-map matches. Used to
 * default `x-product` so test requests satisfy facsWrapper's strict
 * fail-closed contract without each test needing to set the header.
 */
function detectProduct(method, path) {
  const upper = method.toUpperCase();
  // Strip query string for matching.
  const pathOnly = path.split('?')[0];
  for (const { productCode, method: m, regex } of PRODUCT_MATCHERS) {
    if (m === upper && regex.test(pathOnly)) {
      return productCode;
    }
  }
  return null;
}

/**
 * Creates an HTTP client with pre-configured auth personas.
 *
 * The `x-product` header defaults to the product whose `PRODUCTS_ROUTES`
 * sub-map claims the requested URL. Tests that need to assert mismatch
 * scenarios (delegation.js's "wrong x-product → 403") override via
 * `extraHeaders`. Requests for routes that no product claims (internal /
 * S2S / not-FACS-governed) get the legacy `ASO` default.
 *
 * @param {string} baseUrl - The dev server base URL (e.g., http://localhost:3002)
 * @param {{ admin: string, user: string, trialUser: string, llmoAdmin: string,
 *   delegatedUser: string,
 *   delegatedUserTruncated: string, delegatedUserNoSource: string,
 *   readOnlyAdmin: string,
 *   s2sConsumerReadOnly: string, s2sConsumerReadAll: string,
 *   s2sConsumerUnknown: string }} tokens - JWT tokens
 * @returns {{ admin: object, user: object, trialUser: object, llmoAdmin: object,
 *   delegatedUser: object,
 *   delegatedUserTruncated: object, delegatedUserNoSource: object,
 *   readOnlyAdmin: object,
 *   s2sConsumerReadOnly: object, s2sConsumerReadAll: object,
 *   s2sConsumerUnknown: object }}
 */
export function createHttpClient(baseUrl, tokens) {
  async function request(method, path, body, token, extraHeaders = {}) {
    const detected = detectProduct(method, path);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-product': detected || 'ASO',
      ...extraHeaders,
    };

    // Allow callers to omit default headers by setting them to undefined/null
    Object.keys(headers).forEach((key) => {
      if (headers[key] == null) {
        delete headers[key];
      }
    });

    const options = { method, headers };
    if (body !== null && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${baseUrl}${path}`, options);
    const text = await res.text();

    let parsedBody = null;
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }

    return {
      status: res.status,
      headers: res.headers,
      body: parsedBody,
    };
  }

  function makeMethods(token) {
    return {
      get: (path, extraHeaders) => request('GET', path, null, token, extraHeaders),
      post: (path, body, extraHeaders) => request('POST', path, body, token, extraHeaders),
      put: (path, body, extraHeaders) => request('PUT', path, body, token, extraHeaders),
      patch: (path, body, extraHeaders) => request('PATCH', path, body, token, extraHeaders),
      delete: (path, extraHeaders) => request('DELETE', path, null, token, extraHeaders),
    };
  }

  return {
    admin: makeMethods(tokens.admin),
    user: makeMethods(tokens.user),
    trialUser: makeMethods(tokens.trialUser),
    llmoAdmin: makeMethods(tokens.llmoAdmin),
    delegatedUser: makeMethods(tokens.delegatedUser),
    delegatedUserTruncated: makeMethods(tokens.delegatedUserTruncated),
    delegatedUserNoSource: makeMethods(tokens.delegatedUserNoSource),
    readOnlyAdmin: makeMethods(tokens.readOnlyAdmin),
    brandManager: makeMethods(tokens.brandManager),
    s2sConsumerReadOnly: makeMethods(tokens.s2sConsumerReadOnly),
    s2sConsumerReadAll: makeMethods(tokens.s2sConsumerReadAll),
    s2sConsumerUnknown: makeMethods(tokens.s2sConsumerUnknown),
  };
}
