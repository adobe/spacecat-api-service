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
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  LambdaClient,
  CreateFunctionCommand as LambdaCreateFunctionCommand,
  GetFunctionConfigurationCommand,
  ListVersionsByFunctionCommand,
  PublishVersionCommand,
} from '@aws-sdk/client-lambda';
import { hasText } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

// Edge runtime code (Lambda@Edge handler + CloudFront routing function) lives in its own
// module for readability; imported for use here and re-exported to keep the public surface.
import { buildEdgeOptimizeLambdaCode, buildRoutingFunctionCode } from './edge-optimize-edge-code.js';

export { buildEdgeOptimizeLambdaCode, buildRoutingFunctionCode };

// CloudFront is a global service; its control plane lives in us-east-1.
export const EDGE_OPTIMIZE_REGION = 'us-east-1';
export const EDGE_OPTIMIZE_DEFAULT_ROLE_NAME = 'AdobeLLMOptimizerCloudFrontConnectorRole';
const SESSION_NAME = 'llmo-edge-optimize';
const SESSION_DURATION_SECONDS = 900;

// The connector role only permits writes to these exact resource names — keep them in sync
// with the standalone connect-aws-wizard (server.mjs) and the customer-bootstrap-role policy.
export const EDGE_OPTIMIZE_ORIGIN_ID = 'EdgeOptimize_Origin';
export const EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN = 'live.edgeoptimize.net';
export const EDGE_OPTIMIZE_FUNCTION_NAME = 'edgeoptimize-routing';
export const EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME = 'edgeoptimize-origin';
export const EDGE_OPTIMIZE_LAMBDA_ROLE_NAME = 'edgeoptimize-origin-role';

// Per-distribution resource names — the `-adobe-<distId>` suffix keeps the account-level
// CloudFront function, Lambda@Edge function, and its IAM execution role unique per distribution
// (so one AWS account fronting multiple distributions never collides). All stay within the
// connector role's `edgeoptimize-*` (Lambda/role) and `Resource: '*'` (CloudFront) grants, so no
// customer re-onboarding is needed. The EO origin id is intentionally NOT suffixed — it is scoped
// inside the distribution config and cannot collide.
export const eoRoutingFunctionName = (distributionId) => `${EDGE_OPTIMIZE_FUNCTION_NAME}-adobe-${distributionId}`;
export const eoLambdaFunctionName = (distributionId) => `${EDGE_OPTIMIZE_LAMBDA_FUNCTION_NAME}-adobe-${distributionId}`;
export const eoLambdaRoleName = (distributionId) => `${EDGE_OPTIMIZE_LAMBDA_ROLE_NAME}-adobe-${distributionId}`;
// Headers the routing CloudFront Function sets and that must reach the EO origin uncached.
export const EDGE_OPTIMIZE_CACHE_HEADERS = ['x-edgeoptimize-config', 'x-edgeoptimize-url'];
// Name of the custom cache policy we create when cloning an AWS-managed policy.
export const EDGE_OPTIMIZE_CACHE_POLICY_NAME = 'edgeoptimize-cache';

// Per the BYOCDN doc, force the cache policy MinTTL to 0 so agentic responses are not
// over-cached — UNLESS the current MinTTL is already short (<= this many seconds), in which
// case we leave it exactly as the customer configured it.
export const EDGE_OPTIMIZE_MIN_TTL_KEEP_THRESHOLD = 5;

/**
 * Build the per-distribution name for a cache policy cloned from a managed (AWS) policy.
 * Strips the AWS `Managed-` prefix (a custom policy must not carry it) and appends an
 * `-adobe-<distributionId>` suffix so each distribution gets its own clone (no account-level
 * collision when one account fronts multiple distributions). Capped at the 128-char AWS limit.
 *
 * @param {string} sourceName - the source (managed) policy name, e.g. `Managed-CachingOptimized`.
 * @param {string} distributionId - the CloudFront distribution id.
 * @returns {string} e.g. `CachingOptimized-adobe-E2VLBZCBR857CC`.
 */
export function buildEoClonedCachePolicyName(sourceName, distributionId) {
  const base = String(sourceName || 'cache').replace(/^Managed-/i, '');
  return `${base}-adobe-${distributionId}`.slice(0, 128);
}

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
 * Build the custom-header items the EO origin must carry. Mirrors the standalone wizard's
 * apiCreateOrigin (server.mjs) + the CloudFormation installer: `x-edgeoptimize-api-key`
 * authenticates the prerender request to Edge Optimize, `x-forwarded-host` tells EO which site's
 * content to serve, and the optional `x-edgeoptimize-fetcher-key` is for WAF-allowlisted customers.
 * Without these the origin returns no `x-edgeoptimize-request-id` and Verify never goes green.
 *
 * @param {object} headers
 * @param {string} [headers.apiKey] - the site's Edge Optimize API key.
 * @param {string} [headers.forwardedHost] - the customer's canonical site host.
 * @param {string} [headers.fetcherKey] - optional fetcher key (WAF allowlist).
 * @returns {Array<{HeaderName: string, HeaderValue: string}>}
 */
function buildEdgeOptimizeOriginHeaders({ apiKey, forwardedHost, fetcherKey } = {}) {
  const items = [];
  if (hasText(apiKey)) {
    items.push({ HeaderName: 'x-edgeoptimize-api-key', HeaderValue: apiKey });
  }
  if (hasText(forwardedHost)) {
    items.push({ HeaderName: 'x-forwarded-host', HeaderValue: forwardedHost });
  }
  if (hasText(fetcherKey)) {
    items.push({ HeaderName: 'x-edgeoptimize-fetcher-key', HeaderValue: fetcherKey });
  }
  return items;
}

/**
 * Add the Edge Optimize origin to a CloudFront distribution (idempotent + self-healing).
 *
 * Reads the distribution config and, if no Edge Optimize origin exists yet, appends a custom HTTPS
 * origin pointing at the EO target domain with the EO request headers. If the origin already exists
 * but its custom headers do not match the desired set (e.g. it was created header-less by an
 * earlier version), the headers are patched in place. Writes are applied via UpdateDistribution
 * (deploy propagates in the background; we do not block on it).
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} [originDomain] - EO origin domain (env-driven; defaults to the dev EO domain).
 * @param {object} [headers] - EO origin headers ({ apiKey, forwardedHost, fetcherKey }).
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{created, alreadyExisted, updated, originId}>} origin mutation outcome.
 */
export async function createEdgeOptimizeOrigin(
  credentials,
  distributionId,
  originDomain = EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN,
  headers = {},
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const desiredHeaderItems = buildEdgeOptimizeOriginHeaders(headers);

  const client = new CloudFrontClient({ region, credentials });
  const result = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = result.DistributionConfig;
  const etag = result.ETag;
  const origins = config.Origins?.Items || [];

  const existing = origins.find(
    (o) => o.Id === EDGE_OPTIMIZE_ORIGIN_ID || o.DomainName === originDomain,
  );

  if (existing) {
    // Idempotent — but self-heal an origin created without the EO headers (earlier bug): patch its
    // CustomHeaders to the desired set when they differ. Never wipe headers if none were supplied.
    const toMap = (arr) => (arr || []).reduce((acc, h) => {
      acc[h.HeaderName.toLowerCase()] = h.HeaderValue;
      return acc;
    }, {});
    const current = toMap(existing.CustomHeaders?.Items);
    const desired = toMap(desiredHeaderItems);
    const headersMatch = Object.keys(desired).length === Object.keys(current).length
      && Object.entries(desired).every(([k, v]) => current[k] === v);

    if (desiredHeaderItems.length === 0 || headersMatch) {
      return {
        created: false, alreadyExisted: true, updated: false, originId: EDGE_OPTIMIZE_ORIGIN_ID,
      };
    }

    existing.CustomHeaders = { Quantity: desiredHeaderItems.length, Items: desiredHeaderItems };
    await client.send(new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: etag,
      DistributionConfig: config,
    }));
    return {
      created: false, alreadyExisted: true, updated: true, originId: EDGE_OPTIMIZE_ORIGIN_ID,
    };
  }

  origins.push({
    Id: EDGE_OPTIMIZE_ORIGIN_ID,
    DomainName: originDomain,
    OriginPath: '',
    CustomHeaders: { Quantity: desiredHeaderItems.length, Items: desiredHeaderItems },
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

  return {
    created: true, alreadyExisted: false, updated: false, originId: EDGE_OPTIMIZE_ORIGIN_ID,
  };
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
  distributionId,
  targetedPaths = null,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(defaultOriginId)) {
    throw new Error('defaultOriginId is required');
  }
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const functionName = eoRoutingFunctionName(distributionId);
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
      Name: functionName,
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
      Name: functionName,
      IfMatch: existingEtag,
      FunctionConfig: functionConfig,
      FunctionCode: code,
    }));
    etag = updated.ETag;
  } else {
    const created = await client.send(new CreateFunctionCommand({
      Name: functionName,
      FunctionConfig: functionConfig,
      FunctionCode: code,
    }));
    etag = created.ETag;
  }

  await client.send(new PublishFunctionCommand({
    Name: functionName,
    IfMatch: etag,
  }));

  return { name: functionName, created: !existingEtag, stage: 'LIVE' };
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
    if (setMinTTLZero && Number(behavior.MinTTL ?? 0) > EDGE_OPTIMIZE_MIN_TTL_KEEP_THRESHOLD) {
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
    const needsMinTtl = setMinTTLZero
      && Number(pc.MinTTL ?? 0) > EDGE_OPTIMIZE_MIN_TTL_KEEP_THRESHOLD;
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
  const clonedName = buildEoClonedCachePolicyName(sourceName, distributionId);
  cloned.Name = clonedName;
  cloned.Comment = `Cloned from ${sourceName} with Edge Optimize headers — managed by LLM Optimizer`;
  if (setMinTTLZero && Number(cloned.MinTTL ?? 0) > EDGE_OPTIMIZE_MIN_TTL_KEEP_THRESHOLD) {
    cloned.MinTTL = 0;
  }
  const clonedParams = cloned.ParametersInCacheKeyAndForwardedToOrigin || {};
  addEoHeaders(clonedParams);
  cloned.ParametersInCacheKeyAndForwardedToOrigin = clonedParams;

  // Idempotent: reuse an existing clone only when it matches the FULL derived name (exact)
  // <sourceName-without-Managed->-adobe-<distId>. If the customer re-pointed the behavior to a
  // different source since a prior run, the derived name differs, so we create a clone matching the
  // CURRENT source instead of reusing a clone built from a different base.
  const customList = await client.send(new ListCachePoliciesCommand({ Type: 'custom' }));
  const existing = (customList.CachePolicyList?.Items || []).find(
    (i) => i.CachePolicy.CachePolicyConfig.Name === clonedName,
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
  // Fixed DOS date/time (1980-01-01 00:00:00) so the zip — and thus the Lambda CodeSha256 — is
  // deterministic for identical source. A timestamp here would change the hash on every call,
  // causing needless code updates and version churn.
  const dosDate = (0 << 9) | (1 << 5) | 1;
  const dosTime = 0;

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

// Latest published numbered version (skips $LATEST). Returns { versionArn, version, codeSha256 }
// or null when no numbered version has been published yet.
async function getLatestLambdaVersion(lambda, functionName) {
  const resp = await lambda.send(
    new ListVersionsByFunctionCommand({ FunctionName: functionName }),
  );
  const numbered = (resp.Versions || []).filter((v) => v.Version && v.Version !== '$LATEST');
  if (numbered.length === 0) {
    return null;
  }
  const latest = numbered.sort((a, b) => Number(b.Version) - Number(a.Version))[0];
  return { versionArn: latest.FunctionArn, version: latest.Version, codeSha256: latest.CodeSha256 };
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
  {
    region = EDGE_OPTIMIZE_REGION,
    distributionId,
    originDomain = EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN,
    roleWaitMs = 12000,
    retryDelayMs = 5000,
  } = {},
) {
  if (!/^[0-9]{12}$/.test(String(accountId))) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const lambdaName = eoLambdaFunctionName(distributionId);
  const roleName = eoLambdaRoleName(distributionId);
  const lambda = new LambdaClient({ region, credentials });
  const iam = new IAMClient({ region, credentials });

  // Bake the EO origin domain into the handler so it matches the EO origin's DomainName per env.
  const zipBuffer = buildLambdaZip('index.mjs', buildEdgeOptimizeLambdaCode(originDomain));

  // ── 1. Ensure the exec role exists with the current trust policy. ──
  let roleArn;
  let roleIsNew = false;
  try {
    const existing = await iam.send(
      new GetRoleCommand({ RoleName: roleName }),
    );
    roleArn = existing.Role.Arn;
    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: roleName,
      PolicyDocument: LAMBDA_TRUST_POLICY,
    }));
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') {
      throw err;
    }
    const created = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: LAMBDA_TRUST_POLICY,
      Description: 'Execution role for EdgeOptimize Lambda@Edge function',
    }));
    roleArn = created.Role.Arn;
    roleIsNew = true;
  }

  // ── 2. Attach the CloudWatch-logs inline policy. ──
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'EdgeOptimizeLambdaLogging',
    PolicyDocument: buildCwLogsPolicy(String(accountId), lambdaName),
  }));

  // ── 3. Advance the function state machine WITHOUT blocking on provisioning. ──
  // This runs behind a CDN/gateway with a ~60s first-byte timeout, so we must never wait for a
  // fresh function to become Active (30–60s) inside the request. Each call does at most one fast
  // step and returns `status: 'provisioning' | 'ready'`; the UI polls until ready.
  let cfg = null;
  try {
    cfg = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: lambdaName }),
    );
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  // Function does not exist yet → create it (returns fast in Pending) and report provisioning.
  if (!cfg) {
    if (roleIsNew && roleWaitMs > 0) {
      await delay(roleWaitMs);
    }
    let lastErr;
    let createdArn;
    /* eslint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const created = await lambda.send(new LambdaCreateFunctionCommand({
          FunctionName: lambdaName,
          Runtime: 'nodejs24.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: { ZipFile: zipBuffer },
          Description: 'EdgeOptimize origin request/response handler (Lambda@Edge)',
          Timeout: 5,
          MemorySize: 128,
        }));
        createdArn = created.FunctionArn;
        lastErr = null;
        break;
      } catch (createErr) {
        lastErr = createErr;
        // A just-created role may not have propagated yet — short bounded retry, then give up
        // (the next poll will succeed once it propagates) so we never block long.
        const isRolePropagation = createErr.name === 'InvalidParameterValueException'
          && (createErr.message || '').toLowerCase().includes('role');
        if (createErr.name === 'ResourceConflictException') {
          // Created concurrently by a prior (timed-out) call — treat as provisioning.
          lastErr = null;
          break;
        }
        if (!isRolePropagation || attempt >= 2) {
          throw createErr;
        }
        await delay(retryDelayMs);
      }
    }
    /* eslint-enable no-await-in-loop */
    if (lastErr) {
      throw lastErr;
    }
    return {
      status: 'provisioning', functionArn: createdArn, roleArn, created: true, versionArn: null,
    };
  }

  // Still finalizing a create/update → report provisioning, don't touch it (avoids conflicts).
  if (cfg.State === 'Pending' || cfg.LastUpdateStatus === 'InProgress') {
    return {
      status: 'provisioning', functionArn: cfg.FunctionArn, roleArn, created: false, versionArn: null,
    };
  }

  // Active and idle. If a numbered version already exists, reuse it (idempotent).
  const existingVersion = await getLatestLambdaVersion(lambda, lambdaName);
  if (existingVersion) {
    return {
      status: 'ready',
      functionArn: cfg.FunctionArn,
      versionArn: existingVersion.versionArn,
      version: existingVersion.version,
      roleArn,
      created: false,
      alreadyExisted: true,
    };
  }

  // Active, idle, no version yet → publish one (fast on an idle function).
  const published = await lambda.send(new PublishVersionCommand({
    FunctionName: lambdaName,
    Description: 'Published by LLM Optimizer CloudFront wizard',
  }));
  return {
    status: 'ready',
    functionArn: cfg.FunctionArn,
    versionArn: published.FunctionArn, // includes the :N version suffix
    version: published.Version,
    roleArn,
    created: false,
    alreadyExisted: false,
  };
}

/**
 * Read-only status of the Edge Optimize Lambda@Edge function so the wizard can check on entry
 * (and poll after a slow/timed-out create) whether it already exists and has a published version.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} [region] - control-plane region.
 * @returns {Promise<{exists: boolean, state?: string, lastUpdateStatus?: string,
 *   functionArn?: string, versionArn: string|null, version?: string}>}
 */
export async function getEdgeOptimizeLambdaStatus(
  credentials,
  distributionId,
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  const lambdaName = eoLambdaFunctionName(distributionId);
  const roleName = eoLambdaRoleName(distributionId);
  const lambda = new LambdaClient({ region, credentials });
  const iam = new IAMClient({ region, credentials });

  // Execution role status (created synchronously by create-lambda's ack call).
  let roleExists = false;
  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
    roleExists = true;
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') {
      throw err;
    }
  }

  // Function status.
  let cfg;
  try {
    cfg = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: lambdaName }),
    );
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return {
        roleExists, exists: false, versionArn: null, ready: false,
      };
    }
    throw err;
  }
  const latest = await getLatestLambdaVersion(lambda, lambdaName);
  const ready = cfg.State === 'Active' && cfg.LastUpdateStatus !== 'InProgress' && !!latest;
  return {
    roleExists,
    exists: true,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    functionArn: cfg.FunctionArn,
    versionArn: latest?.versionArn || null,
    version: latest?.version,
    ready,
  };
}

/**
 * Read-only inspection of the Lambda@Edge execution role so the Review screen can say whether an
 * existing role (e.g. left by a prior partial run) is the right one. The deploy ALWAYS conforms the
 * role to the required trust (lambda + edgelambda) and CloudWatch-logs policy, so this only drives
 * the wording — it never changes behavior.
 *
 * @param {IAMClient} iam - an IAM client built with the connector credentials.
 * @param {string} roleName - the EO Lambda@Edge execution role name.
 * @returns {Promise<{exists: boolean, trustOk?: boolean, logsPolicyOk?: boolean}>}
 */
async function inspectEdgeOptimizeLambdaRole(iam, roleName) {
  let role;
  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    role = res.Role;
  } catch (err) {
    if (err.name === 'NoSuchEntityException') {
      return { exists: false };
    }
    throw err;
  }

  // Trust must allow both lambda.amazonaws.com and edgelambda.amazonaws.com (Lambda@Edge).
  let trustOk = false;
  const rawTrust = role.AssumeRolePolicyDocument || '';
  if (rawTrust) {
    let doc = null;
    try {
      doc = JSON.parse(decodeURIComponent(rawTrust));
    } catch {
      doc = null;
    }
    const services = ((doc && doc.Statement) || []).flatMap((st) => {
      const svc = st.Principal && st.Principal.Service;
      return Array.isArray(svc) ? svc : [svc];
    }).filter(Boolean);
    trustOk = services.includes('lambda.amazonaws.com')
      && services.includes('edgelambda.amazonaws.com');
  }

  // The CloudWatch-logs inline policy the deploy attaches.
  let logsPolicyOk = false;
  try {
    await iam.send(new GetRolePolicyCommand({
      RoleName: roleName,
      PolicyName: 'EdgeOptimizeLambdaLogging',
    }));
    logsPolicyOk = true;
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') {
      throw err;
    }
  }

  return { exists: true, trustOk, logsPolicyOk };
}

// Edge Optimize owns exactly these association slots on a behavior; every other association is the
// customer's and must be preserved. A non-EO association ON one of these slots is a conflict we
// refuse (rather than overwrite), so customer edge logic is never silently removed.
const EDGE_OPTIMIZE_LAMBDA_EVENTS = ['origin-request', 'origin-response'];
const isEdgeOptimizeFunctionArn = (arn) => /edgeoptimize-routing/i.test(arn || '');
const isEdgeOptimizeLambdaArn = (arn) => /edgeoptimize-origin/i.test(arn || '');

/**
 * Inspect a behavior's existing associations and return a conflict message when a NON-Edge-Optimize
 * association occupies a slot EO needs (a different viewer-request function, a viewer-request
 * Lambda@Edge that CloudFront forbids alongside a function, or an origin-request/origin-response
 * Lambda@Edge). Returns null when EO can be wired in while preserving everything else. EO's own
 * prior associations (matched by name) are never flagged, so re-deploys stay idempotent.
 *
 * @param {object} behavior - the cache behavior config.
 * @param {string} pathPattern - the behavior label (for the message).
 * @returns {string|null}
 */
function findEdgeOptimizeAssociationConflict(behavior, pathPattern) {
  const fns = behavior?.FunctionAssociations?.Items || [];
  const lambdas = behavior?.LambdaFunctionAssociations?.Items || [];

  const viewerFn = fns.find(
    (a) => a.EventType === 'viewer-request' && !isEdgeOptimizeFunctionArn(a.FunctionARN),
  );
  if (viewerFn) {
    return `Behavior '${pathPattern}' already has a different viewer-request function associated `
      + `(${viewerFn.FunctionARN}). Remove it before applying Edge Optimize routing.`;
  }
  const viewerLambda = lambdas.find((a) => a.EventType === 'viewer-request');
  if (viewerLambda) {
    return `Behavior '${pathPattern}' already has a viewer-request Lambda@Edge `
      + `(${viewerLambda.LambdaFunctionARN}) which conflicts with the Edge Optimize routing `
      + 'function. Remove it before applying Edge Optimize routing.';
  }
  const originLambda = lambdas.find(
    (a) => EDGE_OPTIMIZE_LAMBDA_EVENTS.includes(a.EventType)
      && !isEdgeOptimizeLambdaArn(a.LambdaFunctionARN),
  );
  if (originLambda) {
    return `Behavior '${pathPattern}' already has a different ${originLambda.EventType} `
      + `Lambda@Edge associated (${originLambda.LambdaFunctionARN}). Remove it before applying `
      + 'Edge Optimize routing.';
  }
  return null;
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
  const functionName = eoRoutingFunctionName(distributionId);

  const fnResult = await client.send(new DescribeFunctionCommand({
    Name: functionName,
    Stage: 'LIVE',
  }));
  const cfFunctionArn = fnResult.FunctionSummary?.FunctionMetadata?.FunctionARN;
  if (!cfFunctionArn) {
    throw new Error(`CloudFront function '${functionName}' not found or not published to LIVE`);
  }

  const distResult = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = distResult.DistributionConfig;
  const behavior = getBehaviorFromConfig(config, pathPattern);

  // Refuse (rather than silently clobber) if the customer already owns a slot EO needs.
  const conflict = findEdgeOptimizeAssociationConflict(behavior, pathPattern);
  if (conflict) {
    throw new Error(conflict);
  }

  // Merge, don't replace: preserve every association on event types EO does NOT own (e.g. a
  // viewer-response function, a viewer-response lambda) and (re)set ONLY EO's own slots —
  // viewer-request (function) + origin-request/origin-response (lambda). Wholesale replacement here
  // would drop the customer's edge logic.
  const existingFns = behavior.FunctionAssociations?.Items || [];
  const existingLambdas = behavior.LambdaFunctionAssociations?.Items || [];
  const mergedFns = [
    ...existingFns.filter((a) => a.EventType !== 'viewer-request'),
    { FunctionARN: cfFunctionArn, EventType: 'viewer-request' },
  ];
  const mergedLambdas = [
    ...existingLambdas.filter(
      (a) => a.EventType !== 'viewer-request' && !EDGE_OPTIMIZE_LAMBDA_EVENTS.includes(a.EventType),
    ),
    { LambdaFunctionARN: lambdaVersionArn, EventType: 'origin-request', IncludeBody: false },
    { LambdaFunctionARN: lambdaVersionArn, EventType: 'origin-response', IncludeBody: false },
  ];
  behavior.FunctionAssociations = { Quantity: mergedFns.length, Items: mergedFns };
  behavior.LambdaFunctionAssociations = { Quantity: mergedLambdas.length, Items: mergedLambdas };

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
  const botUa = 'chatgpt-user';
  const humanUa = 'Mozilla/5.0';
  const [bot, human] = await Promise.all([
    fetchEdgeOptimizeHeaders(url, botUa),
    fetchEdgeOptimizeHeaders(url, humanUa),
  ]);

  const requestId = bot.headers['x-edgeoptimize-request-id'] || null;
  const passed = Boolean(requestId)
    && !human.headers['x-edgeoptimize-request-id']
    && !human.headers['x-edgeoptimize-fo']
    && human.headers['x-edgeoptimize-proxy'] !== '1';

  // `ua` is carried through so the wizard can show which User-Agent each probe used.
  return {
    passed,
    requestId,
    details: { bot: { ua: botUa, ...bot }, human: { ua: humanUa, ...human } },
  };
}

// The ordered deploy steps + their human labels, in the sequence the orchestrator advances them.
// Exported so the controller/tests can assert the contract without re-declaring it.
export const EDGE_OPTIMIZE_DEPLOY_STEPS = [
  { key: 'origin', label: 'Edge Optimize origin' },
  { key: 'function', label: 'Routing function' },
  { key: 'cache', label: 'Cache policy' },
  { key: 'lambda', label: 'Lambda@Edge' },
  { key: 'associate', label: 'Association' },
  { key: 'propagation', label: 'Propagation' },
  { key: 'verify', label: 'Verify routing' },
];

/**
 * True when the `edgeoptimize-routing` CloudFront Function is already published to LIVE.
 * Used to gate the function step so we never re-publish (which causes deploy churn).
 *
 * @param {CloudFrontClient} client - a CloudFront client built with the connector credentials.
 * @returns {Promise<boolean>}
 */
async function isRoutingFunctionLive(client, distributionId) {
  try {
    const desc = await client.send(new DescribeFunctionCommand({
      Name: eoRoutingFunctionName(distributionId),
      Stage: 'LIVE',
    }));
    return Boolean(desc?.FunctionSummary?.FunctionMetadata?.FunctionARN);
  } catch (err) {
    if (err.name === 'NoSuchFunctionExists') {
      return false;
    }
    throw err;
  }
}

/**
 * True when the target behavior already has BOTH the Edge Optimize routing CloudFront Function
 * (viewer-request) AND the Edge Optimize Lambda@Edge (origin-request) associated. Used to gate the
 * associate step so we never re-issue UpdateDistribution (needless re-deploy) once wired.
 *
 * @param {CloudFrontClient} client - a CloudFront client built with the connector credentials.
 * @param {string} distributionId - the CloudFront distribution ID.
 * @param {string} pathPattern - the behavior to inspect (`default` for the default behavior).
 * @returns {Promise<boolean>}
 */
async function isBehaviorAlreadyAssociated(client, distributionId, pathPattern) {
  const result = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = result.DistributionConfig || {};
  let behavior;
  if (pathPattern === 'default' || pathPattern === 'Default (*)') {
    behavior = config.DefaultCacheBehavior;
  } else {
    behavior = (config.CacheBehaviors?.Items || []).find((b) => b.PathPattern === pathPattern);
  }
  if (!behavior) {
    return false;
  }
  const hasCfFunction = (behavior.FunctionAssociations?.Items || []).some(
    (a) => a.EventType === 'viewer-request' && /edgeoptimize-routing/i.test(a.FunctionARN || ''),
  );
  const hasLambda = (behavior.LambdaFunctionAssociations?.Items || []).some(
    (a) => a.EventType === 'origin-request' && /edgeoptimize-origin/i.test(a.LambdaFunctionARN || ''),
  );
  return hasCfFunction && hasLambda;
}

/**
 * Run one poll of the idempotent Edge Optimize "Deploy routing" orchestrator.
 *
 * Advances the deploy sequence (origin → function → cache → lambda → associate → verify) as far as
 * it safely can in a single call, staying well under the CDN/gateway ~60s first-byte timeout. Each
 * step is gated so a re-poll never re-mutates already-completed work (no CloudFront re-deploy
 * churn, no CF-function re-publish). Designed to be called once and then polled every ~30s by the
 * wizard UI: each call returns the per-step status and the FE keeps polling until verify is green.
 *
 * Stops advancing (returning earlier steps' real status and later steps `pending`) when the
 * Lambda@Edge is still provisioning — the next poll re-checks. A step that throws is marked
 * `error` on its own row (with later steps `pending`); the caller still returns HTTP 200 so the FE
 * shows the failure on that row and a re-poll retries idempotently.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {object} params
 * @param {string} params.distributionId - the CloudFront distribution ID.
 * @param {string} params.originId - the default-behavior target origin id (failover origin).
 * @param {string} params.behavior - the cache behavior to target (`default` for the default).
 * @param {string} [params.originDomain] - the Edge Optimize origin domain.
 * @param {object} [params.originHeaders] - EO origin headers ({ apiKey, forwardedHost }).
 * @param {string} params.accountId - the 12-digit customer AWS account ID.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{routingDeployed: boolean, verified: boolean, steps: Array<object>}>}
 */
export async function runEdgeOptimizeDeployStep(
  credentials,
  {
    distributionId, originId, behavior, originDomain, originHeaders, accountId,
  },
  region = EDGE_OPTIMIZE_REGION,
) {
  // Start every step pending; each handler flips its own row to done/in_progress/error.
  const steps = EDGE_OPTIMIZE_DEPLOY_STEPS.map((s) => ({ ...s, status: 'pending' }));
  const byKey = (key) => steps.find((s) => s.key === key);
  const client = new CloudFrontClient({ region, credentials });

  let routingDeployed = false;
  let verified = false;
  let lambdaVersionArn = null;

  // ── 1. origin — already idempotent (no UpdateDistribution when headers match). ──
  try {
    await createEdgeOptimizeOrigin(
      credentials,
      distributionId,
      originDomain,
      originHeaders,
      region,
    );
    byKey('origin').status = 'done';
  } catch (err) {
    byKey('origin').status = 'error';
    byKey('origin').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 2. function — GATE: skip the create+publish when already LIVE (avoids re-publish churn). ──
  try {
    if (await isRoutingFunctionLive(client, distributionId)) {
      byKey('function').status = 'done';
    } else {
      await createEdgeOptimizeRoutingFunction(credentials, originId, distributionId, null, region);
      byKey('function').status = 'done';
    }
  } catch (err) {
    byKey('function').status = 'error';
    byKey('function').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 3. cache — idempotent (skips UpdateDistribution/UpdateCachePolicy when already applied). ──
  try {
    await applyEdgeOptimizeCacheHeaders(credentials, distributionId, behavior, { region });
    byKey('cache').status = 'done';
  } catch (err) {
    byKey('cache').status = 'error';
    byKey('cache').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 4. lambda — drive the create/publish state machine each poll (idempotent + non-blocking). ──
  // createEdgeOptimizeLambda creates the function when missing, no-ops while it is Pending, and —
  // crucially — PUBLISHES a numbered version once the function is Active (which is what flips it to
  // ready). We must call it on EVERY not-ready poll, not only when the function is missing: the
  // version is published on a later poll (after the function reaches Active), so if we merely
  // status-check while it "exists", the version never gets published and the step hangs at
  // "provisioning" forever.
  try {
    const ls = await getEdgeOptimizeLambdaStatus(credentials, distributionId, region);
    if (ls.ready) {
      lambdaVersionArn = ls.versionArn;
      byKey('lambda').status = 'done';
    } else {
      const created = await createEdgeOptimizeLambda(
        credentials,
        accountId,
        { region, distributionId, originDomain },
      );
      if (created.status === 'ready') {
        lambdaVersionArn = created.versionArn;
        byKey('lambda').status = 'done';
      } else {
        byKey('lambda').status = 'in_progress';
        byKey('lambda').detail = ls.exists
          ? 'Lambda@Edge is still provisioning'
          : 'Lambda@Edge create started';
        return { routingDeployed, verified, steps };
      }
    }
  } catch (err) {
    byKey('lambda').status = 'error';
    byKey('lambda').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 5. associate — GATE: skip UpdateDistribution when the behavior is already wired. ──
  try {
    if (await isBehaviorAlreadyAssociated(client, distributionId, behavior)) {
      byKey('associate').status = 'done';
    } else {
      await applyEdgeOptimizeAssociations(
        credentials,
        distributionId,
        behavior,
        lambdaVersionArn,
        region,
      );
      byKey('associate').status = 'done';
    }
    routingDeployed = true;
  } catch (err) {
    byKey('associate').status = 'error';
    byKey('associate').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 6. propagation — GATE: wait for the distribution to finish deploying before we verify. ──
  // CloudFront reports `Status: 'InProgress'` while it propagates the new behavior/Lambda globally
  // (the console shows "Deploying"); once `Deployed`, edge nodes have the change. Verifying before
  // that just churns, so we hold here and surface the propagation status. distDomain is reused by
  // the verify step so we only list distributions once.
  let distDomain = '';
  try {
    const distributions = await listCloudFrontDistributions(credentials, region);
    const match = distributions.find((d) => d.id === distributionId);
    distDomain = match?.domainName || '';
    if (!match) {
      byKey('propagation').status = 'in_progress';
      byKey('propagation').detail = 'waiting for the distribution to appear';
      return { routingDeployed, verified, steps };
    }
    if (match.status !== 'Deployed') {
      byKey('propagation').status = 'in_progress';
      byKey('propagation').detail = `Deploying — CloudFront is propagating the change globally (status: ${match.status})`;
      return { routingDeployed, verified, steps };
    }
    byKey('propagation').status = 'done';
    byKey('propagation').detail = 'Propagated — the change is live on all edge locations';
  } catch (err) {
    byKey('propagation').status = 'in_progress';
    byKey('propagation').detail = cleanupHeaderValue(err.message);
    return { routingDeployed, verified, steps };
  }

  // ── 7. verify — BEST-EFFORT: in_progress (not error) until the agentic probe is optimized. ──
  try {
    // TEMP (testing only -- DO NOT MERGE): verify against the distribution's own *.cloudfront.net
    // domain (from the dist id) because the dev test domain is not pointed at the distribution.
    // PROD/main verifies the customer's real host -- RESTORE the next line before merge:
    // const domain = String(originHeaders?.forwardedHost || '').trim() || distDomain;
    const domain = distDomain;
    if (!hasText(domain)) {
      byKey('verify').status = 'in_progress';
      byKey('verify').detail = 'waiting for domain';
      return { routingDeployed, verified, steps };
    }
    const result = await verifyEdgeOptimizeRouting(`https://${domain}/`);
    // Per-probe summary the wizard renders (Human vs Agentic): UA, HTTP status, the
    // x-edgeoptimize-request-id value (or null), and whether it failed over to the origin.
    const toProbe = (d) => ({
      ua: d.ua,
      status: d.status,
      requestId: d.headers['x-edgeoptimize-request-id'] || null,
      failover: Boolean(d.headers['x-edgeoptimize-fo']),
    });
    byKey('verify').probe = {
      domain,
      bot: toProbe(result.details.bot),
      human: toProbe(result.details.human),
    };
    if (result.passed) {
      verified = true;
      byKey('verify').status = 'done';
      byKey('verify').detail = `Agentic routing verified — x-edgeoptimize-request-id: ${result.requestId}`;
    } else if (result.details.bot.headers['x-edgeoptimize-fo'] || result.details.human.headers['x-edgeoptimize-fo']) {
      byKey('verify').status = 'in_progress';
      byKey('verify').detail = 'Edge Optimize returned failover (x-edgeoptimize-fo) — serving the origin, not optimized; still retrying';
    } else {
      byKey('verify').status = 'in_progress';
      byKey('verify').detail = 'waiting for propagation';
    }
  } catch (err) {
    // Never fail the whole deploy because verify could not run yet — surface as in_progress.
    byKey('verify').status = 'in_progress';
    byKey('verify').detail = cleanupHeaderValue(err.message);
  }

  return { routingDeployed, verified, steps };
}

/**
 * Read-only "preview" of what {@link runEdgeOptimizeDeployStep} would do, without mutating
 * anything. Powers the wizard's "Review & Deploy" screen: it inspects the distribution config,
 * the attached cache policy, the routing CloudFront Function, and the Lambda@Edge function, and
 * returns a per-step plan (create | exists | update | blocked) plus an overall canProceed/blocker.
 *
 * Only reads are issued (GetDistributionConfig, ListCachePolicies, DescribeFunction,
 * GetFunctionConfiguration/ListVersions via the existing gates). It is intentionally defensive:
 * a missing resource is "create", and a read that genuinely errors is surfaced in that step's
 * detail while still allowing the plan to proceed — the ONLY hard blocker is a behavior that is
 * already associated with EO routes (that is the one case the automation refuses to touch).
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {object} params
 * @param {string} params.distributionId - the CloudFront distribution ID.
 * @param {string} params.originId - the default-behavior target origin id (failover origin).
 * @param {string} params.behavior - the cache behavior to target (`default` for the default).
 * @param {string} [params.originDomain] - the Edge Optimize origin domain.
 * @param {object} [params.originHeaders] - EO origin headers ({ apiKey, forwardedHost }).
 * @param {string} [params.accountId] - the 12-digit customer AWS account ID.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<{canProceed: boolean, blocker: string|null,
 *   steps: Array<{key: string, label: string, action: string, detail: string}>}>}
 */
export async function planEdgeOptimizeDeploy(
  credentials,
  {
    distributionId, behavior, originDomain = EDGE_OPTIMIZE_DEFAULT_ORIGIN_DOMAIN, originHeaders,
  },
  region = EDGE_OPTIMIZE_REGION,
) {
  if (!hasText(distributionId)) {
    throw new Error('distributionId is required');
  }
  if (!hasText(behavior)) {
    throw new Error('behavior is required');
  }
  const client = new CloudFrontClient({ region, credentials });

  // Plan rows mirror EDGE_OPTIMIZE_DEPLOY_STEPS (sans `verify`, which is a post-deploy probe).
  const labelOf = (key) => EDGE_OPTIMIZE_DEPLOY_STEPS.find((s) => s.key === key)?.label || key;
  const steps = ['origin', 'function', 'cache', 'lambda', 'associate'].map((key) => ({
    key, label: labelOf(key), action: 'create', detail: '',
  }));
  const byKey = (key) => steps.find((s) => s.key === key);

  let canProceed = true;
  let blocker = null;

  // Read the distribution config ONCE for the origin + cache inspections.
  let config = null;
  try {
    const distResult = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
    config = distResult.DistributionConfig || null;
  } catch (err) {
    // A read failure here doesn't block — surface it on the origin/cache rows and keep going.
    byKey('origin').detail = `could not read distribution config: ${err.message}`;
    byKey('cache').detail = `could not read distribution config: ${err.message}`;
  }

  // ── origin ──────────────────────────────────────────────────────────────
  // 'exists' when the EO origin is already present WITH the required custom headers; otherwise
  // 'create' (a header-less existing origin still needs the headers patched → treated as create).
  const desiredHeaderItems = buildEdgeOptimizeOriginHeaders(originHeaders || {});
  if (config) {
    const origins = config.Origins?.Items || [];
    const existing = origins.find(
      (o) => o.Id === EDGE_OPTIMIZE_ORIGIN_ID || o.DomainName === originDomain,
    );
    if (existing) {
      const toMap = (arr) => (arr || []).reduce((acc, h) => {
        acc[h.HeaderName.toLowerCase()] = h.HeaderValue;
        return acc;
      }, {});
      const current = toMap(existing.CustomHeaders?.Items);
      const desired = toMap(desiredHeaderItems);
      const headersMatch = desiredHeaderItems.length === 0
        || (Object.keys(desired).length === Object.keys(current).length
          && Object.entries(desired).every(([k, v]) => current[k] === v));
      if (headersMatch) {
        byKey('origin').action = 'exists';
        byKey('origin').detail = `Edge Optimize origin already present (${existing.DomainName})`;
      } else {
        byKey('origin').detail = `patch Edge Optimize origin headers (${existing.DomainName})`;
      }
    } else {
      byKey('origin').detail = `add Edge Optimize origin (${originDomain})`;
    }
  } else if (!byKey('origin').detail) {
    byKey('origin').detail = `add Edge Optimize origin (${originDomain})`;
  }

  // ── function ────────────────────────────────────────────────────────────
  // 'exists' when the routing CloudFront Function is already published to LIVE.
  try {
    if (await isRoutingFunctionLive(client, distributionId)) {
      byKey('function').action = 'exists';
      byKey('function').detail = `routing function ${eoRoutingFunctionName(distributionId)} already published to LIVE`;
    } else {
      byKey('function').detail = `create routing function ${eoRoutingFunctionName(distributionId)}`;
    }
  } catch (err) {
    byKey('function').detail = `could not read routing function status: ${err.message}`;
  }

  // ── cache ───────────────────────────────────────────────────────────────
  // Detect the scenario the deploy would hit (legacy / custom / managed) and describe it without
  // mutating. Mirrors applyEdgeOptimizeCacheHeaders' detection logic.
  try {
    if (!config) {
      throw new Error('distribution config unavailable');
    }
    const targetBehavior = getBehaviorFromConfig(config, behavior);
    const policyId = targetBehavior.CachePolicyId;
    // Only mention the MinTTL change when it would ACTUALLY change — i.e. the current MinTTL is
    // above the keep threshold (<= 5s is left as-is). Empty string otherwise so we don't show it.
    const ttlNote = (currentMinTtl) => (
      Number(currentMinTtl ?? 0) > EDGE_OPTIMIZE_MIN_TTL_KEEP_THRESHOLD
        ? ' Minimum TTL will be set to 0.'
        : ''
    );
    if (!policyId) {
      // Legacy: ForwardedValues. 'exists' when EO headers are already forwarded.
      const fv = targetBehavior.ForwardedValues || {};
      const lower = (fv.Headers?.Items || []).map((x) => x.toLowerCase());
      const allForwarded = lower.includes('*')
        || EDGE_OPTIMIZE_CACHE_HEADERS.every((h) => lower.includes(h));
      if (allForwarded) {
        byKey('cache').action = 'exists';
        byKey('cache').detail = 'This behavior already forwards the Edge Optimize headers.';
      } else {
        byKey('cache').action = 'update';
        byKey('cache').detail = `Add the Edge Optimize headers to this behavior.${ttlNote(targetBehavior.MinTTL)}`;
      }
    } else {
      const managedList = await client.send(new ListCachePoliciesCommand({ Type: 'managed' }));
      const managedIds = new Set(
        (managedList.CachePolicyList?.Items || []).map((i) => i.CachePolicy.Id),
      );
      const isManaged = managedIds.has(policyId);
      if (!isManaged) {
        // Custom policy → updated in place (idempotent). If our headers are already in the cache
        // key AND the MinTTL won't change, it is already configured (e.g. our own clone from a
        // prior deploy) → 'No change'; otherwise 'update'. Mirrors applyEdgeOptimizeCacheHeaders.
        const pcResult = await client.send(new GetCachePolicyConfigCommand({ Id: policyId }));
        const pc = pcResult.CachePolicyConfig || {};
        const hc = pc.ParametersInCacheKeyAndForwardedToOrigin?.HeadersConfig || {};
        const headerItems = (hc.Headers?.Items || []).map((x) => x.toLowerCase());
        const headersPresent = hc.HeaderBehavior === 'allViewer' || hc.HeaderBehavior === 'all'
          || EDGE_OPTIMIZE_CACHE_HEADERS.every((h) => headerItems.includes(h));
        const ttlChange = ttlNote(pc.MinTTL);
        if (headersPresent && !ttlChange) {
          byKey('cache').action = 'exists';
          byKey('cache').detail = `Current policy: ${pc.Name || 'custom'}. Already has the Edge Optimize headers.`;
        } else {
          byKey('cache').action = 'update';
          byKey('cache').detail = `Current policy: ${pc.Name || 'custom'}. Add the Edge Optimize headers in place.${ttlChange}`;
        }
      } else {
        // Managed → must clone. 'exists' when the per-dist clone already exists (idempotent).
        const srcResult = await client.send(new GetCachePolicyCommand({ Id: policyId }));
        const srcConfig = srcResult.CachePolicy?.CachePolicyConfig || {};
        const sourceName = srcConfig.Name || 'cache';
        const clonedName = buildEoClonedCachePolicyName(sourceName, distributionId);
        // Match the FULL derived name (exact): <sourceName-without-Managed->-adobe-<distId> — not
        // just the suffix. If the customer re-pointed the behavior to a different source, a clone
        // with a different prefix is NOT a match, so the deploy creates one for the current source.
        const customList = await client.send(new ListCachePoliciesCommand({ Type: 'custom' }));
        const cloneExists = (customList.CachePolicyList?.Items || []).some(
          (i) => i.CachePolicy.CachePolicyConfig.Name === clonedName,
        );
        if (cloneExists) {
          // The copy exists from a prior run, but the behavior is still on the AWS-managed policy
          // (if it were already on the copy we'd be in the custom branch above) — created but not
          // associated. The deploy will switch the behavior to the copy, so this is an 'update',
          // not a no-op. Surface both names + that it isn't associated yet.
          byKey('cache').action = 'update';
          byKey('cache').detail = `Current policy: ${sourceName} (AWS-managed). A copy `
            + `"${clonedName}" already exists but is not associated with this behavior `
            + `yet — the behavior will be switched to it.${ttlNote(srcConfig.MinTTL)}`;
        } else {
          byKey('cache').action = 'create';
          byKey('cache').detail = `Current policy: ${sourceName} (AWS-managed, can't be edited). A copy will be created: ${clonedName}.${ttlNote(srcConfig.MinTTL)}`;
        }
      }
    }
  } catch (err) {
    // Don't block the plan on a cache read failure — surface it on the row.
    byKey('cache').action = 'update';
    byKey('cache').detail = `could not determine cache scenario: ${err.message}`;
  }

  // ── lambda ──────────────────────────────────────────────────────────────
  // 'exists' when the Lambda@Edge function exists (ready or still provisioning); else 'create'.
  // Also surface the execution role: a role with our name may already exist from a prior partial
  // run. We say whether it is correctly configured — the deploy ALWAYS conforms it to the required
  // trust (lambda + edgelambda) + logs policy, so a mismatch is auto-corrected, not a blocker.
  try {
    const iam = new IAMClient({ region, credentials });
    const roleName = eoLambdaRoleName(distributionId);
    const [ls, role] = await Promise.all([
      getEdgeOptimizeLambdaStatus(credentials, distributionId, region),
      inspectEdgeOptimizeLambdaRole(iam, roleName),
    ]);
    let roleNote;
    if (!role.exists) {
      roleNote = ` Execution role ${roleName} will be created.`;
    } else if (role.trustOk && role.logsPolicyOk) {
      roleNote = ` Execution role ${roleName} already exists and is correctly configured `
        + '(trust + logs) — it will be reused.';
    } else {
      roleNote = ` Execution role ${roleName} already exists but is not correctly configured `
        + '— the deploy will correct its trust + logs policy.';
    }
    if (ls.exists) {
      byKey('lambda').action = 'exists';
      byKey('lambda').detail = (ls.ready
        ? `Lambda@Edge ${eoLambdaFunctionName(distributionId)} already published.`
        : `Lambda@Edge ${eoLambdaFunctionName(distributionId)} exists (still provisioning).`)
        + roleNote;
    } else {
      byKey('lambda').detail = `create Lambda@Edge ${eoLambdaFunctionName(distributionId)}.${roleNote}`;
    }
  } catch (err) {
    byKey('lambda').detail = `could not read Lambda@Edge status: ${err.message}`;
  }

  // ── associate ───────────────────────────────────────────────────────────
  // HARD BLOCK in two cases: (1) the behavior is already EO-associated (nothing to do), or (2) the
  // customer already owns a slot EO needs (a different viewer-request function, a viewer-request
  // lambda, or an origin-request/response lambda) — we refuse rather than remove their edge logic.
  // Otherwise EO is merged in, preserving every other association on the behavior.
  try {
    const assocBehavior = config ? getBehaviorFromConfig(config, behavior) : null;
    const assocConflict = assocBehavior
      ? findEdgeOptimizeAssociationConflict(assocBehavior, behavior) : null;
    if (await isBehaviorAlreadyAssociated(client, distributionId, behavior)) {
      byKey('associate').action = 'blocked';
      byKey('associate').detail = 'this behaviour is already associated with Edge Optimize routes';
      canProceed = false;
      blocker = "This behaviour is already associated with routes, please recheck — can't proceed with this automation.";
    } else if (assocConflict) {
      byKey('associate').action = 'blocked';
      byKey('associate').detail = assocConflict;
      canProceed = false;
      blocker = assocConflict;
    } else {
      byKey('associate').detail = 'will add the routing function + Lambda@Edge, '
        + 'preserving your other associations on this behavior';
    }
  } catch (err) {
    byKey('associate').detail = `could not read behavior associations: ${err.message}`;
  }

  return { canProceed, blocker, steps };
}
