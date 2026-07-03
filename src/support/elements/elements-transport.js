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
import { ErrorWithStatusCode } from '../utils.js';
import { ElementsTransportError } from './errors.js';

const ELEMENTS_API_PATH = '/enterprise/pages/api/v3/workspaces';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Validates and returns the canonical origin of SEMRUSH_PROJECTS_BASE_URL.
 * Enforces HTTPS. Returns `protocol//host` with no trailing path so URL
 * segments injected later cannot be escaped by a misconfigured base URL.
 */
function baseUrl(env) {
  const raw = typeof env?.SEMRUSH_PROJECTS_BASE_URL === 'string'
    ? env.SEMRUSH_PROJECTS_BASE_URL.trim()
    : env?.SEMRUSH_PROJECTS_BASE_URL;
  if (!hasText(raw)) {
    throw new ErrorWithStatusCode(
      'SEMRUSH_PROJECTS_BASE_URL is not set. Configure it via Vault '
      + '(dx_mysticat/<env>/api-service) or .env for local dev.',
      503,
    );
  }
  const candidate = raw.replace(/\/$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL is not a valid URL: ${candidate}`,
      503,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL must use https (got ${parsed.protocol})`,
      503,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new ElementsTransportError(401, 'Missing IMS bearer token for Elements transport');
  }
  return {
    Authorization: `Bearer ${imsToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
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

function enc(segment) {
  return encodeURIComponent(String(segment ?? ''));
}

async function request(url, imsToken, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    method: 'POST',
    headers: buildHeaders(imsToken),
    signal: controller.signal,
    body: JSON.stringify(body),
  };
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ElementsTransportError(504, `Elements API POST ${url} timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new ElementsTransportError(
      response.status,
      `Elements API POST ${url} failed: ${response.status}`,
      parsed,
    );
  }
  return parsed;
}

/**
 * Creates the Semrush Elements API HTTP transport.
 * All element calls are POST requests authenticated with the caller's IMS bearer token.
 *
 * @param {object} args
 * @param {object} args.env - Environment (reads SEMRUSH_PROJECTS_BASE_URL).
 * @param {string} args.imsToken - IMS user bearer token (without 'Bearer ' prefix).
 */
export function createElementsTransport({ env, imsToken }) {
  const root = baseUrl(env);

  return {
    /**
     * POST /enterprise/pages/api/v3/workspaces/{workspaceId}/products/ai/elements/{elementId}/data
     */
    async fetchElement(workspaceId, elementId, payload) {
      const url = `${root}${ELEMENTS_API_PATH}/${enc(workspaceId)}/products/ai/elements/${enc(elementId)}/data`;
      return request(url, imsToken, payload);
    },
  };
}
