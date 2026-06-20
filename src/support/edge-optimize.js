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

import { deflateRawSync } from 'node:zlib';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  CloudFrontClient,
  ListDistributionsCommand,
  GetDistributionConfigCommand,
  GetCachePolicyConfigCommand,
  GetCachePolicyCommand,
  ListCachePoliciesCommand,
  CreateCachePolicyCommand,
  UpdateCachePolicyCommand,
  CreateFunctionCommand,
  UpdateFunctionCommand,
  DescribeFunctionCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  LambdaClient,
  CreateFunctionCommand as LambdaCreateFunctionCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  PublishVersionCommand,
} from '@aws-sdk/client-lambda';
import { hasText } from '@adobe/spacecat-shared-utils';

// CloudFront is a global service; its control plane lives in us-east-1.
export const EDGE_OPTIMIZE_REGION = 'us-east-1';
export const EDGE_OPTIMIZE_DEFAULT_ROLE_NAME = 'AdobeLLMOptimizerCloudFrontConnectorRole';
const SESSION_NAME = 'llmo-edge-optimize';
const SESSION_DURATION_SECONDS = 900;

// The connector role only permits writes to these exact resource names — keep them in sync
// with the standalone connect-aws-wizard (server.mjs) and the customer-bootstrap-role policy.
export const EDGE_OPTIMIZE_ORIGIN_ID = 'EdgeOptimize_Origin';
export const EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN = 'dev.edgeoptimize.net';
export const EDGE_OPTIMIZE_FUNCTION_NAME = 'edgeoptimize-routing';
export const EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME = 'edgeoptimize-origin';
export const EDGE_OPTIMIZE_LAMBDA_ROLE_NAME = 'edgeoptimize-origin-role';
// Headers the routing CloudFront Function sets and that must reach the EO origin uncached.
export const EDGE_OPTIMIZE_CACHE_HEADERS = ['x-edgeoptimize-config', 'x-edgeoptimize-url'];
// Name of the custom cache policy we create when cloning an AWS-managed policy.
export const EDGE_OPTIMIZE_CACHE_POLICY_NAME = 'edgeoptimize-cache';

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Assume the customer's cross-account connector role and return short-lived credentials.
 *
 * The api-service Lambda execution role (the default credential chain) assumes the role the
 * customer created via the CloudFormation bootstrap, scoped by the per-session external ID.
 * Credentials are short-lived — callers should use them immediately for a single operation
 * and never persist them in the browser.
 *
 * @param {object} params
 * @param {string} params.accountId - 12-digit customer AWS account ID.
 * @param {string} params.externalId - external ID baked into the connector role trust policy.
 * @param {string} [params.roleName] - connector role name (defaults to the standard name).
 * @param {string} [params.region] - STS region.
 * @returns {Promise<{roleArn: string, accountId: string, credentials: object}>}
 */
export async function assumeConnectorRole({
  accountId,
  externalId,
  roleName = EDGE_OPTIMIZE_DEFAULT_ROLE_NAME,
  region = EDGE_OPTIMIZE_REGION,
}) {
  if (!/^[0-9]{12}$/.test(String(accountId))) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }
  if (!hasText(externalId)) {
    throw new Error('externalId is required');
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  const sts = new STSClient({ region });
  const response = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: SESSION_NAME,
    ExternalId: externalId,
    DurationSeconds: SESSION_DURATION_SECONDS,
  }));

  const creds = response?.Credentials;
  if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
    throw new Error('Failed to assume connector role: no credentials returned');
  }

  return {
    roleArn,
    accountId: String(accountId),
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      expiration: creds.Expiration,
    },
  };
}

/**
 * List the CloudFront distributions in the customer account using assumed-role credentials.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<Array<object>>} distributions projected to the fields the wizard needs.
 */
export async function listCloudFrontDistributions(credentials, region = EDGE_OPTIMIZE_REGION) {
  const client = new CloudFrontClient({ region, credentials });
  const response = await client.send(new ListDistributionsCommand({}));
  const items = response?.DistributionList?.Items || [];
  return items.map((dist) => ({
    id: dist.Id,
    domainName: dist.DomainName,
    aliases: dist.Aliases?.Items || [],
    status: dist.Status,
    enabled: dist.Enabled === true,
    comment: dist.Comment || '',
  }));
}

/**
 * Fetch a single CloudFront distribution's configuration using assumed-role credentials.
 *
 * Returns the parsed origins, default cache behavior, and ordered cache behaviors projected to
 * the fields the wizard needs to inspect routing. Read-only — uses GetDistributionConfig.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{origins: Array<object>, defaultCacheBehavior: object|null,
 *   cacheBehaviors: Array<object>}>}
 */
export async function getDistributionConfig(
  credentials,
  distributionId,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const client = new CloudFrontClient({ region, credentials });
  const response = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = response?.DistributionConfig || {};

  const origins = (config.Origins?.Items || []).map((origin) => ({
    id: origin.Id,
    domainName: origin.DomainName,
    originPath: origin.OriginPath || '',
  }));

  const mapBehavior = (behavior) => ({
    pathPattern: behavior.PathPattern,
    targetOriginId: behavior.TargetOriginId,
  });

  const defaultCacheBehavior = config.DefaultCacheBehavior
    ? mapBehavior({ ...config.DefaultCacheBehavior, PathPattern: 'Default (*)' })
    : null;

  const cacheBehaviors = (config.CacheBehaviors?.Items || []).map(mapBehavior);

  return { origins, defaultCacheBehavior, cacheBehaviors };
}

/**
 * Locate a behavior on a parsed DistributionConfig by its path pattern. The default behavior is
 * addressed with the pseudo-pattern `default` (or `Default (*)`, the projection used by the read
 * endpoints).
 *
 * @param {object} config - a raw CloudFront DistributionConfig.
 * @param {string} pathPattern - the behavior path pattern, or `default`/`Default (*)`.
 * @returns {object} the raw behavior object (mutating it mutates the config).
 */
function getBehaviorFromConfig(config, pathPattern) {
  if (pathPattern === 'default' || pathPattern === 'Default (*)') {
    return config.DefaultCacheBehavior;
  }
  const behavior = (config.CacheBehaviors?.Items || []).find((b) => b.PathPattern === pathPattern);
  if (!behavior) {
    throw new Error(`Behavior not found: ${pathPattern}`);
  }
  return behavior;
}

/**
 * Add the Edge Optimize origin to a CloudFront distribution (idempotent).
 *
 * Mirrors the standalone wizard's create-origin: reads the distribution config, and — only if no
 * Edge Optimize origin exists yet — appends a custom HTTPS origin pointing at the EO target domain
 * with the EO request headers, then writes it back via UpdateDistribution (deploy propagates in the
 * background; we do not block on it).
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} [originDomain] - EO origin domain (env-driven; defaults to the dev EO domain).
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{created: boolean, alreadyExisted: boolean, originId: string}>}
 */
export async function createEdgeOptimizeOrigin(
  credentials,
  distributionId,
  originDomain = EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const client = new CloudFrontClient({ region, credentials });
  const result = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = result.DistributionConfig;
  const etag = result.ETag;
  const origins = config.Origins?.Items || [];

  const alreadyExisted = origins.some(
    (o) => o.Id === EDGE_OPTIMIZE_ORIGIN_ID || o.DomainName === originDomain,
  );

  if (alreadyExisted) {
    return { created: false, alreadyExisted: true, originId: EDGE_OPTIMIZE_ORIGIN_ID };
  }

  origins.push({
    Id: EDGE_OPTIMIZE_ORIGIN_ID,
    DomainName: originDomain,
    OriginPath: '',
    CustomHeaders: { Quantity: 0, Items: [] },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'https-only',
      OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
  });
  config.Origins = { Quantity: origins.length, Items: origins };

  await client.send(new UpdateDistributionCommand({
    Id: distributionId,
    IfMatch: etag,
    DistributionConfig: config,
  }));

  return { created: true, alreadyExisted: false, originId: EDGE_OPTIMIZE_ORIGIN_ID };
}

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

/**
 * Create or update the `edgeoptimize-routing` CloudFront Function and publish it to LIVE
 * (idempotent). Mirrors the standalone wizard's create-function step.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} defaultOriginId - the default-behavior target origin id (baked into the code).
 * @param {string[]|null} [targetedPaths] - explicit paths to target, or null for all HTML pages.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{name: string, created: boolean, stage: string}>}
 */
export async function createEdgeOptimizeRoutingFunction(
  credentials,
  defaultOriginId,
  targetedPaths = null,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(defaultOriginId)) {
    throw new Error('defaultOriginId is required');
  }
  const client = new CloudFrontClient({ region, credentials });
  const code = Buffer.from(buildRoutingFunctionCode(defaultOriginId, targetedPaths), 'utf-8');
  const functionConfig = {
    Comment: 'EdgeOptimize agentic bot routing — managed by LLM Optimizer',
    Runtime: 'cloudfront-js-2.0',
  };

  // Look up the DEVELOPMENT stage to get its ETag (needed to update an existing function).
  let existingEtag = null;
  try {
    const desc = await client.send(new DescribeFunctionCommand({
      Name: EDGE_OPTIMIZE_FUNCTION_NAME,
      Stage: 'DEVELOPMENT',
    }));
    existingEtag = desc.ETag;
  } catch (err) {
    if (err.name !== 'NoSuchFunctionExists') {
      throw err;
    }
  }

  let etag;
  if (existingEtag) {
    const updated = await client.send(new UpdateFunctionCommand({
      Name: EDGE_OPTIMIZE_FUNCTION_NAME,
      IfMatch: existingEtag,
      FunctionConfig: functionConfig,
      FunctionCode: code,
    }));
    etag = updated.ETag;
  } else {
    const created = await client.send(new CreateFunctionCommand({
      Name: EDGE_OPTIMIZE_FUNCTION_NAME,
      FunctionConfig: functionConfig,
      FunctionCode: code,
    }));
    etag = created.ETag;
  }

  await client.send(new PublishFunctionCommand({
    Name: EDGE_OPTIMIZE_FUNCTION_NAME,
    IfMatch: etag,
  }));

  return { name: EDGE_OPTIMIZE_FUNCTION_NAME, created: !existingEtag, stage: 'LIVE' };
}

/**
 * Add the Edge Optimize routing headers to the cache key/forwarded set for the target behavior.
 *
 * Ported from the standalone wizard's detect-cache + apply-cache (server.mjs). Handles all three
 * scenarios the wizard supports, because real distributions commonly use an AWS-managed policy:
 *   - `legacy`  — behavior has no CachePolicyId (uses ForwardedValues): add EO headers there.
 *   - `custom`  — behavior uses a customer-owned cache policy: UpdateCachePolicy to add EO headers.
 *   - `managed` — behavior uses an AWS-managed policy (cannot be updated → "update is not allowed
 *     for this policy"): CLONE it into a custom `edgeoptimize-cache` policy with EO headers and
 *     repoint the behavior to it. Idempotent by policy name.
 * `setMinTTLZero` (default true) forces MinTTL to 0 so agentic responses are not over-cached.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} pathPattern - the behavior to target (`default` for the default behavior).
 * @param {object} [opts]
 * @param {boolean} [opts.setMinTTLZero=true] - force the policy MinTTL to 0.
 * @param {string} [opts.region] - CloudFront control-plane region.
 * @returns {Promise<{scenario: string, policyId: string|null, updated: boolean,
 *   alreadyForwarded: boolean, reused?: boolean}>}
 */
export async function applyEdgeOptimizeCacheHeaders(
  credentials,
  distributionId,
  pathPattern,
  { setMinTTLZero = true, region = EDGE_OPTIMIZE_REGION } = {},
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  if (!hasText(pathPattern)) {
    throw new Error('pathPattern is required');
  }
  const client = new CloudFrontClient({ region, credentials });

  const distResult = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = distResult.DistributionConfig;
  const behavior = getBehaviorFromConfig(config, pathPattern);
  const policyId = behavior.CachePolicyId;

  // ── Scenario A: legacy (ForwardedValues, no CachePolicyId) ──────────────
  if (!policyId) {
    const fv = behavior.ForwardedValues || {};
    const items = fv.Headers?.Items || [];
    const lower = items.map((x) => x.toLowerCase());
    let changed = false;
    if (!lower.includes('*')) {
      EDGE_OPTIMIZE_CACHE_HEADERS.forEach((h) => {
        if (!lower.includes(h)) {
          items.push(h);
          changed = true;
        }
      });
      fv.Headers = { Quantity: items.length, Items: items };
      behavior.ForwardedValues = fv;
    }
    if (setMinTTLZero && behavior.MinTTL !== 0) {
      behavior.MinTTL = 0;
      changed = true;
    }
    if (!changed) {
      return {
        scenario: 'legacy', policyId: null, updated: false, alreadyForwarded: true,
      };
    }
    await client.send(new UpdateDistributionCommand({
      Id: distributionId, IfMatch: distResult.ETag, DistributionConfig: config,
    }));
    return {
      scenario: 'legacy', policyId: null, updated: true, alreadyForwarded: false,
    };
  }

  // Determine whether the attached policy is AWS-managed (managed policies cannot be updated).
  const managedList = await client.send(new ListCachePoliciesCommand({ Type: 'managed' }));
  const managedIds = new Set(
    (managedList.CachePolicyList?.Items || []).map((i) => i.CachePolicy.Id),
  );
  const isManaged = managedIds.has(policyId);

  // Helper: add the EO headers to a HeadersConfig in place; returns true if anything changed.
  const addEoHeaders = (params) => {
    const hc = params.HeadersConfig || { HeaderBehavior: 'none' };
    if (hc.HeaderBehavior === 'allViewer' || hc.HeaderBehavior === 'all') {
      return false;
    }
    const items = hc.Headers?.Items || [];
    const lower = items.map((x) => x.toLowerCase());
    const missing = EDGE_OPTIMIZE_CACHE_HEADERS.filter((h) => !lower.includes(h));
    if (missing.length === 0) {
      return false;
    }
    missing.forEach((h) => items.push(h));
    hc.HeaderBehavior = 'whitelist';
    hc.Headers = { Quantity: items.length, Items: items };
    // eslint-disable-next-line no-param-reassign
    params.HeadersConfig = hc;
    return true;
  };

  // ── Scenario B: custom policy → update it in place ──────────────────────
  if (!isManaged) {
    const pcResult = await client.send(new GetCachePolicyConfigCommand({ Id: policyId }));
    const pc = pcResult.CachePolicyConfig;
    const params = pc.ParametersInCacheKeyAndForwardedToOrigin || {};
    const headersChanged = addEoHeaders(params);
    pc.ParametersInCacheKeyAndForwardedToOrigin = params;
    const needsMinTtl = setMinTTLZero && pc.MinTTL !== 0;
    if (!headersChanged && !needsMinTtl) {
      return {
        scenario: 'custom', policyId, updated: false, alreadyForwarded: true,
      };
    }
    if (needsMinTtl) {
      pc.MinTTL = 0;
    }
    await client.send(new UpdateCachePolicyCommand({
      Id: policyId, IfMatch: pcResult.ETag, CachePolicyConfig: pc,
    }));
    return {
      scenario: 'custom', policyId, updated: true, alreadyForwarded: false,
    };
  }

  // ── Scenario C: managed policy → clone into edgeoptimize-cache + repoint ──
  const srcResult = await client.send(new GetCachePolicyCommand({ Id: policyId }));
  const cloned = JSON.parse(JSON.stringify(srcResult.CachePolicy.CachePolicyConfig));
  const sourceName = cloned.Name;
  cloned.Name = EDGE_OPTIMIZE_CACHE_POLICY_NAME;
  cloned.Comment = `Cloned from ${sourceName} with Edge Optimize headers — managed by LLM Optimizer`;
  if (setMinTTLZero) {
    cloned.MinTTL = 0;
  }
  const clonedParams = cloned.ParametersInCacheKeyAndForwardedToOrigin || {};
  addEoHeaders(clonedParams);
  cloned.ParametersInCacheKeyAndForwardedToOrigin = clonedParams;

  // Idempotent: reuse an existing edgeoptimize-cache custom policy if a prior run created it.
  const customList = await client.send(new ListCachePoliciesCommand({ Type: 'custom' }));
  const existing = (customList.CachePolicyList?.Items || []).find(
    (i) => i.CachePolicy.CachePolicyConfig.Name === EDGE_OPTIMIZE_CACHE_POLICY_NAME,
  );
  let newPolicyId;
  let reused = false;
  if (existing) {
    newPolicyId = existing.CachePolicy.Id;
    reused = true;
  } else {
    const created = await client.send(new CreateCachePolicyCommand({ CachePolicyConfig: cloned }));
    newPolicyId = created.CachePolicy.Id;
  }

  // Re-read the distribution for a fresh ETag, repoint the behavior to the new custom policy.
  const freshDist = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const freshConfig = freshDist.DistributionConfig;
  const freshBehavior = getBehaviorFromConfig(freshConfig, pathPattern);
  freshBehavior.CachePolicyId = newPolicyId;
  delete freshBehavior.ForwardedValues; // cannot coexist with CachePolicyId
  await client.send(new UpdateDistributionCommand({
    Id: distributionId, IfMatch: freshDist.ETag, DistributionConfig: freshConfig,
  }));

  return {
    scenario: 'managed', policyId: newPolicyId, updated: true, alreadyForwarded: false, reused,
  };
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
      if (originDomain === 'dev.edgeoptimize.net') {
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

const LAMBDA_TRUST_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'] },
    Action: 'sts:AssumeRole',
  }],
});

function buildCwLogsPolicy(accountId, functionName) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'logs:CreateLogGroup',
        Resource: `arn:aws:logs:*:${accountId}:*`,
      },
      {
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [`arn:aws:logs:*:${accountId}:log-group:/aws/lambda/us-east-1.${functionName}:*`],
      },
    ],
  });
}

// ── Minimal zip builder (no external deps) — ported from the standalone wizard's buildZip. ──
// CRC32 + ZIP local/central directory headers are inherently bit-twiddling and densely packed; the
// helix lint rules against bitwise ops, multiple statements per line, and long lines do not fit
// binary-format code, so they are disabled for this block only.
/* eslint-disable no-bitwise, max-statements-per-line, max-len */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) { c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xFF]; }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build an in-memory zip containing a single file. Used to package the Lambda@Edge code without
 * adding a zip dependency to the runtime bundle.
 *
 * @param {string} filename - the entry name inside the zip (e.g. `index.mjs`).
 * @param {string|Buffer} content - the file content.
 * @returns {Buffer} the zip archive bytes.
 */
export function buildLambdaZip(filename, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const compressed = deflateRawSync(data, { level: 9 });
  const crcVal = crc32(data);
  const fn = Buffer.from(filename, 'utf-8');
  const now = new Date();
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);

  const lh = Buffer.alloc(30 + fn.length);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crcVal, 14); lh.writeUInt32LE(compressed.length, 18);
  lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(fn.length, 26); lh.writeUInt16LE(0, 28);
  fn.copy(lh, 30);

  const cd = Buffer.alloc(46 + fn.length);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(dosTime, 12);
  cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crcVal, 16);
  cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(fn.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); fn.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(lh.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lh, compressed, cd, eocd]);
}
/* eslint-enable no-bitwise, max-statements-per-line, max-len */

async function waitForLambdaActive(lambda, functionName, maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    const cfg = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    );
    if (cfg.State === 'Active') {
      return;
    }
    if (cfg.State === 'Failed') {
      throw new Error(`Lambda function entered Failed state: ${cfg.StateReason}`);
    }
    await delay(2000);
  }
  /* eslint-enable no-await-in-loop */
  throw new Error('Lambda function did not become Active within 30 s');
}

/**
 * Create (or update) the `edgeoptimize-origin` Lambda@Edge function and publish a version
 * (idempotent). Mirrors the standalone wizard's create-lambda step: ensure the exec role exists
 * (trusting lambda + edgelambda) with a basic CloudWatch-logs inline policy, then create/update the
 * function code and publish a numbered version. Newly-created IAM roles take a few seconds to
 * propagate, so the create path retries CreateFunction with a bounded back-off
 * (up to ~5×5s, within ~30s).
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} accountId - the 12-digit customer AWS account ID (for the logs-policy ARNs).
 * @param {object} [opts]
 * @param {string} [opts.region] - control-plane region (Lambda@Edge must be us-east-1).
 * @param {number} [opts.roleWaitMs] - extra wait after creating a new role before first create.
 * @param {number} [opts.retryDelayMs] - back-off between CreateFunction role-propagation retries.
 * @returns {Promise<{functionArn: string, versionArn: string, version: string,
 *   roleArn: string, created: boolean}>}
 */
export async function createEdgeOptimizeLambda(
  credentials,
  accountId,
  { region = EDGE_OPTIMIZE_REGION, roleWaitMs = 12000, retryDelayMs = 5000 } = {},
) {
  if (!/^[0-9]{12}$/.test(String(accountId))) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }
  const lambda = new LambdaClient({ region, credentials });
  const iam = new IAMClient({ region, credentials });

  const zipBuffer = buildLambdaZip('index.mjs', EDGE_OPTIMIZE_LAMBDA_CODE);

  // ── 1. Ensure the exec role exists with the current trust policy. ──
  let roleArn;
  let roleIsNew = false;
  try {
    const existing = await iam.send(
      new GetRoleCommand({ RoleName: EDGE_OPTIMIZE_LAMBDA_ROLE_NAME }),
    );
    roleArn = existing.Role.Arn;
    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: EDGE_OPTIMIZE_LAMBDA_ROLE_NAME,
      PolicyDocument: LAMBDA_TRUST_POLICY,
    }));
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') {
      throw err;
    }
    const created = await iam.send(new CreateRoleCommand({
      RoleName: EDGE_OPTIMIZE_LAMBDA_ROLE_NAME,
      AssumeRolePolicyDocument: LAMBDA_TRUST_POLICY,
      Description: 'Execution role for EdgeOptimize Lambda@Edge function',
    }));
    roleArn = created.Role.Arn;
    roleIsNew = true;
  }

  // ── 2. Attach the CloudWatch-logs inline policy. ──
  await iam.send(new PutRolePolicyCommand({
    RoleName: EDGE_OPTIMIZE_LAMBDA_ROLE_NAME,
    PolicyName: 'EdgeOptimizeLambdaLogging',
    PolicyDocument: buildCwLogsPolicy(String(accountId), EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME),
  }));

  // ── 3. Create or update the function code. ──
  let functionArn;
  let fnExists = false;
  try {
    await lambda.send(
      new GetFunctionCommand({ FunctionName: EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME }),
    );
    fnExists = true;
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  if (fnExists) {
    const updated = await lambda.send(new UpdateFunctionCodeCommand({
      FunctionName: EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME,
      ZipFile: zipBuffer,
    }));
    functionArn = updated.FunctionArn;
  } else {
    if (roleIsNew && roleWaitMs > 0) {
      await delay(roleWaitMs);
    }
    let lastErr;
    /* eslint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const created = await lambda.send(new LambdaCreateFunctionCommand({
          FunctionName: EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME,
          Runtime: 'nodejs24.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: { ZipFile: zipBuffer },
          Description: 'EdgeOptimize origin request/response handler (Lambda@Edge)',
          Timeout: 5,
          MemorySize: 128,
        }));
        functionArn = created.FunctionArn;
        lastErr = null;
        break;
      } catch (createErr) {
        lastErr = createErr;
        const isRolePropagation = createErr.name === 'InvalidParameterValueException'
          && (createErr.message || '').toLowerCase().includes('role');
        if (!isRolePropagation || attempt >= 4) {
          throw createErr;
        }
        await delay(retryDelayMs);
      }
    }
    /* eslint-enable no-await-in-loop */
    if (lastErr) {
      throw lastErr;
    }
  }

  // ── 4. Wait for Active, then publish a version (Lambda@Edge requires a numbered version). ──
  await waitForLambdaActive(lambda, EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME);
  const published = await lambda.send(new PublishVersionCommand({
    FunctionName: EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME,
    Description: 'Published by LLM Optimizer CloudFront wizard',
  }));

  return {
    functionArn,
    versionArn: published.FunctionArn, // includes the :N version suffix
    version: published.Version,
    roleArn,
    created: !fnExists,
  };
}

/**
 * Wire the routing CloudFront Function (viewer-request) and the Lambda@Edge function
 * (origin-request + origin-response) onto a selected cache behavior. Mirrors the standalone
 * wizard's apply-associations step.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} pathPattern - the behavior to wire (`default` for the default behavior).
 * @param {string} lambdaVersionArn - the published, versioned Lambda@Edge ARN.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{cfFunctionArn: string, lambdaArn: string}>}
 */
export async function applyEdgeOptimizeAssociations(
  credentials,
  distributionId,
  pathPattern,
  lambdaVersionArn,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  if (!hasText(pathPattern)) {
    throw new Error('pathPattern is required');
  }
  if (!hasText(lambdaVersionArn)) {
    throw new Error('lambdaVersionArn is required');
  }
  const client = new CloudFrontClient({ region, credentials });

  const fnResult = await client.send(new DescribeFunctionCommand({
    Name: EDGE_OPTIMIZE_FUNCTION_NAME,
    Stage: 'LIVE',
  }));
  const cfFunctionArn = fnResult.FunctionSummary?.FunctionMetadata?.FunctionARN;
  if (!cfFunctionArn) {
    throw new Error(`CloudFront function '${EDGE_OPTIMIZE_FUNCTION_NAME}' not found or not published to LIVE`);
  }

  const distResult = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = distResult.DistributionConfig;
  const behavior = getBehaviorFromConfig(config, pathPattern);

  // Surface a conflicting viewer-request association rather than silently clobbering it.
  const existingViewerFns = (behavior.FunctionAssociations?.Items || [])
    .filter((a) => a.EventType === 'viewer-request' && a.FunctionARN !== cfFunctionArn);
  if (existingViewerFns.length > 0) {
    throw new Error(
      `Behavior '${pathPattern}' already has a different viewer-request function associated `
      + `(${existingViewerFns[0].FunctionARN}). Remove it before applying Edge Optimize routing.`,
    );
  }

  behavior.FunctionAssociations = {
    Quantity: 1,
    Items: [{ FunctionARN: cfFunctionArn, EventType: 'viewer-request' }],
  };
  behavior.LambdaFunctionAssociations = {
    Quantity: 2,
    Items: [
      { LambdaFunctionARN: lambdaVersionArn, EventType: 'origin-request', IncludeBody: false },
      { LambdaFunctionARN: lambdaVersionArn, EventType: 'origin-response', IncludeBody: false },
    ],
  };

  await client.send(new UpdateDistributionCommand({
    Id: distributionId,
    IfMatch: distResult.ETag,
    DistributionConfig: config,
  }));

  return { cfFunctionArn, lambdaArn: lambdaVersionArn };
}

async function fetchEdgeOptimizeHeaders(url, userAgent) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': userAgent },
  });
  const headers = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-edgeoptimize')) {
      headers[key.toLowerCase()] = value;
    }
  });
  // Drain the body so the connection can be reused/closed.
  await response.arrayBuffer().catch(() => {});
  return { status: response.status, headers };
}

/**
 * Verify Edge Optimize routing end-to-end by fetching the distribution domain as an agentic bot
 * and as a human, then inspecting the `x-edgeoptimize-*` headers. Mirrors the standalone wizard's
 * verify logic: success REQUIRES `x-edgeoptimize-request-id` on the bot response (served from the
 * Edge Optimize prerender cache). `x-edgeoptimize-fo` means failover to origin — routing worked but
 * the page is NOT optimised, which is NOT success.
 *
 * @param {string} url - the URL to probe (typically `https://<distribution-domain>/`).
 * @returns {Promise<{passed: boolean, requestId: string|null,
 *   details: {bot: object, human: object}}>}
 */
export async function verifyEdgeOptimizeRouting(url) {
  if (!hasText(url)) {
    throw new Error('url is required');
  }
  const [bot, human] = await Promise.all([
    fetchEdgeOptimizeHeaders(url, 'chatgpt-user'),
    fetchEdgeOptimizeHeaders(url, 'Mozilla/5.0'),
  ]);

  const requestId = bot.headers['x-edgeoptimize-request-id'] || null;
  const passed = Boolean(requestId)
    && !human.headers['x-edgeoptimize-request-id']
    && !human.headers['x-edgeoptimize-fo']
    && human.headers['x-edgeoptimize-proxy'] !== '1';

  return { passed, requestId, details: { bot, human } };
}
