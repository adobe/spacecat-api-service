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

import { hasText } from '@adobe/spacecat-shared-utils';
import { SerenityTransportError } from './rest-transport.js';

/**
 * Transport for the Semrush v4-raw Reporting API used by the Brand Presence
 * dashboard widgets. Distinct from `rest-transport.js` (Projects API, cookie
 * auth) — this one targets the customer-facing Reporting API with an `Apikey`
 * header and a different base URL.
 */

const DEFAULT_BASE_URL = 'https://api.semrush.com';
const API_PREFIX = '/apis/v4-raw/external-api/v1';

function baseUrl(env) {
  return (env?.SEMRUSH_REPORTING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function apikey(env) {
  return (env?.SEMRUSH_REPORTING_API_KEY || '').trim();
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createSerenityReportingTransport({ env }) {
  const key = apikey(env);
  if (!hasText(key)) {
    throw new SerenityTransportError(
      503,
      'SEMRUSH_REPORTING_API_KEY is not configured',
    );
  }
  const root = baseUrl(env);

  return {
    /**
     * POST .../workspaces/{ws}/products/ai/elements/{elementId}
     *
     * `body` is the raw `{ render_data: {...} }` payload from `api_requests.md`.
     * Returned response is forwarded verbatim to the caller.
     */
    async queryElement(workspaceId, elementId, body) {
      if (!hasText(workspaceId)) {
        throw new SerenityTransportError(400, 'Missing workspaceId');
      }
      if (!hasText(elementId)) {
        throw new SerenityTransportError(400, 'Missing elementId');
      }
      const url = `${root}${API_PREFIX}/workspaces/${workspaceId}/products/ai/elements/${elementId}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Apikey ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
      });
      const parsed = await parseBody(response);
      if (!response.ok) {
        throw new SerenityTransportError(
          response.status,
          `Semrush reporting POST ${url} failed: ${response.status}`,
          parsed,
        );
      }
      return parsed;
    },
  };
}
