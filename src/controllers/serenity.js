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

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createResponse, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { attachSrFiltersToSuccessfulBody } from '../support/serenity/visibility-filters.js';
import { normalizeVisibilityV1SuccessfulBody } from '../support/serenity/visibility-response-normalize.js';

const AI_VISIBILITY_PREFIX = '/apis/serenity/v1/ai-visibility';

function relPath(pathname) {
  return pathname.slice(AI_VISIBILITY_PREFIX.length);
}

async function callBridgeLambda(lambdaName, pathWithQuery) {
  const client = new LambdaClient({});
  const res = await client.send(new InvokeCommand({
    FunctionName: lambdaName,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ path: pathWithQuery }),
  }));
  if (res.FunctionError) {
    const errText = res.Payload ? new TextDecoder().decode(res.Payload) : res.FunctionError;
    return { status: 502, body: { error: 'bridge_error', message: errText } };
  }
  const text = new TextDecoder().decode(res.Payload);
  const parsed = JSON.parse(text);
  let body;
  try {
    body = JSON.parse(parsed.body);
  } catch {
    body = { error: 'bridge_bad_payload', raw: parsed.body?.slice?.(0, 500) };
    return { status: 502, body };
  }
  return { status: parsed.statusCode, body };
}

async function callBridgeHttp(baseUrl, pathWithQuery) {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathWithQuery}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function SerenityController(ctx) {
  const { log, env } = ctx;
  const bridgeLambda = env.SR_GRPC_ADAPTER_LAMBDA_NAME?.trim();
  const bridgeUrl = env.SR_GRPC_ADAPTER_URL?.trim();

  const proxy = async (context) => {
    const url = new URL(context.request.url);
    const rel = relPath(url.pathname);
    const pathWithQuery = `${context.pathInfo.suffix}${url.search}`;
    const { searchParams } = url;

    let status;
    let body;
    try {
      if (bridgeLambda) {
        ({ status, body } = await callBridgeLambda(bridgeLambda, pathWithQuery));
      } else if (bridgeUrl) {
        ({ status, body } = await callBridgeHttp(bridgeUrl, pathWithQuery));
      } else {
        return createResponse({ error: 'bridge_not_configured' }, 503);
      }
    } catch (e) {
      log.error('Serenity bridge call failed', e);
      return internalServerError('Serenity bridge unavailable');
    }

    if (status !== 200) {
      return createResponse(body, status);
    }

    const normalized = normalizeVisibilityV1SuccessfulBody(rel, body);
    const merged = attachSrFiltersToSuccessfulBody(200, normalized, searchParams);
    return createResponse(merged, 200);
  };

  return {
    getBrandsStats: proxy,
    getBrandsTopics: proxy,
    getBrandsPrompts: proxy,
    getBrandsCitedPages: proxy,
    getBrandsTopicOpportunities: proxy,
    getBrandsTopBrands: proxy,
    getBrandsCitedSources: proxy,
    getBrandsSourceOpportunities: proxy,
    getBrandsCompetitors: proxy,
    getCompetitorsMetrics: proxy,
    getCompetitorsGapTopics: proxy,
    getCompetitorsGapSourceDomains: proxy,
    getCompetitorsGapPrompts: proxy,
    getMeta: proxy,
    getPromptsResponses: proxy,
    getPromptsResponsesLatest: proxy,
    getTopicsResearchStats: proxy,
    getTopicsResearch: proxy,
    getTopicsStats: proxy,
    getTopicsResearchPrompts: proxy,
    getTopicsResearchBrands: proxy,
    getTopicsResearchSourceDomains: proxy,
  };
}

export default SerenityController;
