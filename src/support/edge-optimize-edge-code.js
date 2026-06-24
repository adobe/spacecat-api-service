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
 * Edge runtime code for the CloudFront "Optimize at Edge" onboarding, kept out of the
 * orchestrator (edge-optimize.js) so it stays readable. Both exports are plain JS-module
 * strings (not sibling-file reads) so the helix-deploy bundle preserves them — see CLAUDE.md
 * "Lambda Bundle Constraints".
 */

/**
 * Build the CloudFront Function (viewer-request) routing code. Ported verbatim from the standalone
 * wizard's `buildFunctionCode` (server.mjs). It detects agentic bots on HTML pages and, for them,
 * creates a request origin group that fails over from the Edge Optimize origin to the default
 * origin.
 *
 * @param {string} defaultOriginId - the distribution's default-behavior target origin id.
 * @param {string[]|null} [targetedPaths] - explicit paths to target, or null for "all HTML pages".
 * @returns {string} the CloudFront Function source code.
 */
export function buildRoutingFunctionCode(defaultOriginId, targetedPaths = null) {
  const targetedPathsValue = targetedPaths === null ? 'null' : JSON.stringify(targetedPaths);

  return `import cf from 'cloudfront';

function handler(event) {
    var request = event.request;
    var headers = request.headers;

    delete headers['x-edgeoptimize-api-key'];
    delete headers['x-edgeoptimize-url'];
    delete headers['x-edgeoptimize-config'];

    var AGENTIC_BOTS = ['AdobeEdgeOptimize-AI', 'ChatGPT-User', 'GPTBot', 'OAI-SearchBot', 'PerplexityBot', 'Perplexity-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot'];
    var TARGETED_PATHS = ${targetedPathsValue};

    var userAgent = headers['user-agent'] ? headers['user-agent'].value.toLowerCase() : '';
    var isEdgeOptimizeRequest = headers['x-edgeoptimize-request'];

    var path = request.uri;
    var pattern = /(?:\\/[^./]+|\\.html|\\/)$/;
    var isHtmlPage = pattern.test(path);

    var isTargetedPath = TARGETED_PATHS === null
        ? isHtmlPage
        : isHtmlPage && TARGETED_PATHS.includes(path);

    var isAgenticBot = AGENTIC_BOTS.some(function(bot) {
        return userAgent.includes(bot.toLowerCase());
    });

    if (!isEdgeOptimizeRequest && isAgenticBot && isTargetedPath) {
        request.headers['x-edgeoptimize-url'] = { value: request.uri };
        request.headers['x-edgeoptimize-config'] = { value: "LLMCLIENT=true" };

        console.log("Adding origin group for userAgent: " + userAgent);

        cf.createRequestOriginGroup({
            "originIds": [
                { "originId": "EdgeOptimize_Origin" },
                { "originId": "${defaultOriginId}" }
            ],
            "failoverCriteria": {
                "statusCodes": [400, 403, 404, 416, 500, 502, 503, 504]
            }
        });

        console.log("Routing to Edge Optimize origin for userAgent: " + userAgent);
        return request;
    }

    console.log("Routing to Default origin for userAgent: " + userAgent);
    return request;
}`;
}

// The Lambda@Edge origin-request/response handler, ported verbatim from the standalone wizard's
// templates/origin-request-response.js. Kept as an inline JS module string (not a sibling-file
// read) so the helix-deploy bundle preserves it — see CLAUDE.md "Lambda Bundle Constraints".
export const EDGE_OPTIMIZE_LAMBDA_CODE = `function hasHeader(map, name) {
  const h = map?.[name];
  return Array.isArray(h) && h.length > 0 && (h[0].value || '').trim() !== '';
}

function setHeader(map, name, value) {
  if (map) {
    map[name.toLowerCase()] = [{ key: name, value: String(value) }];
  }
}

export const handler = async (event) => {
  const request = event?.Records?.[0]?.cf?.request;
  const response = event?.Records?.[0]?.cf?.response;
  const eventType = event.Records[0].cf.config.eventType;
  const reqHeaders = request.headers || {};

  if (eventType === 'origin-request') {
    const originDomain = request.origin?.custom?.domainName;
    const isEdgeOptimizeConfig = hasHeader(reqHeaders, 'x-edgeoptimize-config');
    const isEdgeOptimizeRequest = hasHeader(reqHeaders, 'x-edgeoptimize-request');

    if (isEdgeOptimizeConfig && !isEdgeOptimizeRequest) {
      if (originDomain === 'live.edgeoptimize.net') {
        console.log("Calling Edge Optimize Origin for agentic requests");
        setHeader(request.headers, 'host', originDomain);
      } else {
        console.log("Calling Default Origin in case of failover for agentic requests");
        setHeader(request.headers, 'x-edgeoptimize-request', 'fo');
      }
    }

    return request;

  } else if (eventType === 'origin-response') {
    const resHeaders = response.headers || {};
    const isEdgeOptimizeConfig = hasHeader(reqHeaders, 'x-edgeoptimize-config');
    const isEdgeOptimizeRequestId = hasHeader(resHeaders, 'x-edgeoptimize-request-id');

    if (isEdgeOptimizeConfig && !isEdgeOptimizeRequestId) {
      setHeader(response.headers, 'x-edgeoptimize-fo', '1');
      setHeader(response.headers, 'cache-control', 'no-store');
      console.log('Failover Triggered for agentic requests');
    }

    return response;
  }
};
`;
