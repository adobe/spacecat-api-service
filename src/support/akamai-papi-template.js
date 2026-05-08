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

/**
 * Builds the Akamai origin behavior pointing to live.edgeoptimize.net.
 * @returns {object} Origin behavior object.
 */
function buildOriginBehavior() {
  return {
    name: 'origin',
    options: {
      originType: 'CUSTOMER',
      hostname: 'live.edgeoptimize.net',
      forwardHostHeader: 'REQUEST_HOST_HEADER',
      cacheKeyHostname: 'ORIGIN_HOSTNAME',
      compress: true,
      enableTrueClientIp: false,
      httpPort: 80,
      httpsPort: 443,
      originSni: true,
      verificationMode: 'CUSTOM_CODES',
      originSslProtocols: {
        TLSv1_2: true,
        TLSv1_3: true,
      },
      customValidCnValues: [
        '{{Origin Hostname}}',
        '{{Forward Host Header}}',
        '*.edgeoptimize.net',
      ],
      customCertificateAuthorities: [],
      customCertificates: [],
    },
  };
}

/**
 * Builds the setVariable behavior for the Edge Optimize cache key.
 * @returns {object} setVariable behavior object.
 */
function buildSetVariableBehavior() {
  return {
    name: 'setVariable',
    options: {
      variableName: 'PMUSER_EDGE_OPTIMIZE_CACHE_KEY',
      valueSource: 'EXPRESSION',
      variableValue: 'LLMCLIENT=TRUE;X_FORWARDED_HOST={{builtin.AK_HOST}}',
    },
  };
}

/**
 * Builds a modifyIncomingRequestHeader behavior.
 * @param {string} headerName - The name of the header to add.
 * @param {string} headerValue - The value of the header to add.
 * @returns {object} modifyIncomingRequestHeader behavior object.
 */
function buildModifyIncomingHeaderBehavior(headerName, headerValue) {
  return {
    name: 'modifyIncomingRequestHeader',
    options: {
      action: 'ADD',
      standardAddHeaderName: 'OTHER',
      headerName,
      headerValue,
    },
  };
}

/**
 * Builds a modifyOutgoingRequestHeader behavior.
 * @param {string} headerName - The name of the header to add.
 * @param {string} headerValue - The value of the header to add.
 * @returns {object} modifyOutgoingRequestHeader behavior object.
 */
function buildModifyOutgoingHeaderBehavior(headerName, headerValue) {
  return {
    name: 'modifyOutgoingRequestHeader',
    options: {
      action: 'ADD',
      standardAddHeaderName: 'OTHER',
      headerName,
      headerValue,
    },
  };
}

/**
 * Builds the Edge Optimize AI Bot Routing child rule.
 * @param {string} domain - The customer domain.
 * @param {string} apiKey - The Edge Optimize API key.
 * @returns {object} Child rule object.
 */
function buildEdgeOptimizeRule(domain, apiKey) {
  return {
    name: 'Edge Optimize – AI Bot Routing',
    criteriaMustSatisfy: 'all',
    comments: `Routes AI bot traffic for ${domain} to live.edgeoptimize.net`,
    criteria: [
      {
        name: 'userAgent',
        options: {
          matchOperator: 'IS_ONE_OF',
          matchWildcard: true,
          matchCaseSensitive: false,
          values: [
            '*ChatGPT-User*',
            '*GPTBot*',
            '*OAI-SearchBot*',
            '*PerplexityBot*',
            '*anthropic-ai*',
            '*ClaudeBot*',
            '*Applebot-Extended*',
            '*Google-Extended*',
            '*Bytespider*',
            '*Meta-ExternalAgent*',
            '*DuckAssistBot*',
          ],
        },
      },
      {
        name: 'fileExtension',
        options: {
          matchCaseSensitive: false,
          matchOperator: 'IS_NOT_ONE_OF',
          values: [
            'css', 'js', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'ico',
            'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp4', 'mp3',
            'avi', 'mov', 'pdf', 'zip', 'tar', 'gz', 'xml', 'txt',
          ],
        },
      },
    ],
    behaviors: [
      buildOriginBehavior(),
      buildSetVariableBehavior(),
      buildModifyIncomingHeaderBehavior('x-edgeoptimize-api-key', apiKey),
      buildModifyIncomingHeaderBehavior('x-edgeoptimize-config', 'LLMCLIENT=TRUE;'),
      buildModifyIncomingHeaderBehavior('x-edgeoptimize-url', '{{builtin.AK_SCHEME}}://{{builtin.AK_HOST}}{{builtin.AK_URL}}'),
      buildModifyOutgoingHeaderBehavior('x-forwarded-host', '{{builtin.AK_HOST}}'),
    ],
    children: [],
  };
}

/**
 * Generates a pre-filled Akamai Property Manager API (PAPI) JSON configuration
 * for "Optimize at Edge" CDN routing.
 *
 * @param {string} domain - The customer domain (hostname).
 * @param {string} apiKey - The Edge Optimize API key.
 * @returns {object} PAPI JSON configuration object.
 */
export function generateAkamaiPapiConfig(domain, apiKey) {
  return {
    rules: {
      name: 'default',
      comments: `Edge Optimize configuration for ${domain}. Generated by LLM Optimizer.`,
      variables: [
        {
          name: 'PMUSER_EDGE_OPTIMIZE_CACHE_KEY',
          value: '',
          description: 'Cache key for Edge Optimize AI bot routing',
          hidden: false,
          sensitive: false,
        },
      ],
      behaviors: [],
      children: [
        buildEdgeOptimizeRule(domain, apiKey),
      ],
      options: {
        is_secure: false,
      },
    },
  };
}
