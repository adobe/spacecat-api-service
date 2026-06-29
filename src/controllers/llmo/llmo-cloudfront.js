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

import {
  ok, badRequest, forbidden, notFound, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isValidUrl } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import crypto from 'crypto';
import yaml from 'js-yaml';
import TokowakaClient, {
  calculateForwardedHost,
  assumeConnectorRole,
  verifyRouting as verifyAwsRouting,
  CloudFrontEdgeClient,
} from '@adobe/spacecat-shared-tokowaka-client';
import AccessControlUtil from '../../support/access-control-util.js';
import { getHostnameWithoutWww } from '../../support/edge-routing-utils.js';

// The site's effective base URL for host derivation: the configured `overrideBaseURL` when valid,
// else the site's baseURL. Mirrors the AEM-CS-Fastly edge-routing path (controllers/llmo/llmo.js)
// and the shared client's getEffectiveBaseURL, so CloudFront routing resolves the same host as the
// rest of the Edge Optimize pipeline (which keys content by the forwarded host of this URL).
const effectiveBaseURL = (site) => {
  const overrideBaseURL = site.getConfig?.()?.getFetchConfig?.()?.overrideBaseURL;
  return isValidUrl(overrideBaseURL) ? overrideBaseURL : site.getBaseURL();
};

// CloudFormation templates use intrinsic-function tags (!Ref/!Sub/!GetAtt/...) that plain YAML
// rejects. This schema tolerates them (constructing each to its raw value) so the permissions
// endpoint can read the human-readable Metadata.AdobeLLMOptimizerPermissions block out of the
// connector role template — the SINGLE SOURCE shared with the actual IAM policy.
const CFN_INTRINSIC_TAGS = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'Split', 'GetAZs', 'ImportValue',
  'FindInMap', 'Base64', 'Cidr', 'And', 'Or', 'Not', 'Equals', 'If', 'Condition', 'Transform',
];
const CFN_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  CFN_INTRINSIC_TAGS.flatMap((tag) => ['scalar', 'sequence', 'mapping'].map(
    (kind) => new yaml.Type(`!${tag}`, { kind, construct: (data) => data }),
  )),
);

// targetedPaths is an optional allowlist (route only these paths instead of all HTML pages),
// used mainly for testing — so it is meant to be a short list. The paths are embedded into the
// viewer-request CloudFront Function, which AWS caps at 10 KB of code; keeping the list small
// (and each entry bounded) leaves ample headroom even as the base function grows over time.
const TARGETED_PATHS_MAX_ENTRIES = 20;
const TARGETED_PATHS_MAX_ENTRY_LENGTH = 256;

/**
 * Controller for the CloudFront "Optimize at Edge" onboarding wizard. Mirrors the structure of
 * the Cloudflare onboarding controller: it owns the multi-step, cross-account control-plane flow
 * (bootstrap role → connect → inspect → mutate → verify) used by the LLMO UI to wire a customer's
 * CloudFront distribution to Edge Optimize. Every endpoint is gated on site access + LLMO admin.
 */
function LlmoCloudFrontController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * POST /sites/{siteId}/llmo/cdn-onboard/cloudfront/bootstrap-url
   * Builds a one-click CloudFormation quick-create URL (with a server-side
   * presigned template URL) the customer uses to create the cross-account
   * connector role in their own AWS account. Presigning runs with the service
   * execution role, so the template bucket stays private (no public endpoint)
   * and the customer needs no S3 access.
   * @param {object} context - Request context
   * @returns {Promise<Response>} Bootstrap details + CloudFormation quick-create URL
   */
  const createBootstrapUrl = async (context) => {
    const {
      log, dataAccess, env, s3,
    } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }
      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can generate the CloudFront bootstrap URL');
      }

      // The template-hosting S3 bucket — per-environment, from Vault
      // (dx_mysticat/<env>/api-service.SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET).
      // Read same-account; the customer fetches it via a presigned URL.
      const bucket = env.SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET;
      if (!hasText(bucket) || !s3?.s3Client) {
        return badRequest('CloudFront template hosting is not configured for this environment');
      }

      const key = env.EDGE_OPTIMIZE_TEMPLATE_KEY || 'customer-bootstrap-role.yaml';
      const region = 'us-east-1';
      const roleName = env.EDGE_OPTIMIZE_ROLE_NAME || 'AdobeLLMOptimizerCloudFrontConnectorRole';
      const stackName = env.EDGE_OPTIMIZE_STACK_NAME || 'adobe-edgeoptimize-connector-role';
      // Short-lived presign: the customer opens the link immediately, so a tight TTL
      // shrinks the exposure window if the URL leaks (it only grants GetObject on this
      // one template object until expiry — see security notes). Override via env.
      const presignTtlSeconds = Number(env.EDGE_OPTIMIZE_PRESIGN_TTL || 900);
      const externalId = crypto.randomUUID();
      const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
      // The Adobe principal allowed to assume the customer's connector role — per-environment,
      // from Vault (dx_mysticat/<env>/api-service.SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN).
      const trustedPrincipalArn = env.SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN;
      if (!hasText(trustedPrincipalArn)) {
        return badRequest('CloudFront connector is not configured for this environment (missing trusted principal)');
      }

      // Presign the (private) template so the customer's CloudFormation can read it
      // cross-account via the signature — no public bucket, no customer S3 access.
      const templateUrl = await s3.getSignedUrl(
        s3.s3Client,
        new s3.GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: presignTtlSeconds },
      );

      const params = {
        TrustedPrincipalArn: trustedPrincipalArn,
        ExternalId: externalId,
        RoleName: roleName,
      };
      const qs = new URLSearchParams();
      qs.set('templateURL', templateUrl);
      qs.set('stackName', stackName);
      Object.entries(params).forEach(([k, v]) => qs.set(`param_${k}`, v));
      const quickCreateUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${qs.toString()}`;

      log.info(`[cdn-onboard-cloudfront] Generated bootstrap URL for site ${siteId}, account ${accountId}`);

      return ok({
        externalId,
        roleName,
        roleArn,
        trustedPrincipalArn,
        stackName,
        quickCreateUrl,
        presignTtlSeconds,
      });
    } catch (error) {
      log.error(`Failed to generate CloudFront bootstrap URL for site ${siteId}:`, error);
      return internalServerError('Failed to generate the CloudFront bootstrap URL, please try again');
    }
  };

  // Shared access gate for the CloudFront "Deploy routing" wizard endpoints: the caller
  // must have access to the site and be an LLMO administrator. Returns { error } (a Response)
  // when denied, or {} when allowed.
  const gateEdgeOptimizeWizard = async (siteId, Site, action) => {
    const site = await Site.findById(siteId);
    if (!site) {
      return { error: notFound('Site not found') };
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return { error: forbidden('User does not have access to this site') };
    }
    if (!accessControlUtil.isLLMOAdministrator()) {
      return { error: forbidden(`Only LLMO administrators can ${action}`) };
    }
    return { site };
  };

  // Shared input validation for the CloudFront wizard endpoints that act through the
  // cross-account connector role. Parses + validates the caller-supplied AWS account id and
  // per-session external id (and optionally the CloudFront distribution id). Returns
  // `{ accountId, externalId, distributionId, error }` where `error` is a badRequest Response
  // when validation fails (undefined otherwise) — keeping the messages/status identical to the
  // previously inlined checks.
  const validateCloudfrontCredentials = (context, { requireDistribution = false } = {}) => {
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();

    if (accountId.length !== 12) {
      return { error: badRequest('accountId must be a 12-digit AWS account ID') };
    }
    if (!hasText(externalId)) {
      return { error: badRequest('externalId is required') };
    }
    if (requireDistribution && !hasText(distributionId)) {
      return { error: badRequest('distributionId is required') };
    }
    // CloudFront distribution IDs are uppercase alphanumeric, 12–14 chars — reject garbage early.
    if (hasText(distributionId) && !/^[A-Z0-9]{12,14}$/.test(distributionId)) {
      return { error: badRequest('distributionId must be a valid CloudFront distribution ID') };
    }
    return { accountId, externalId, distributionId };
  };

  const assumeCloudFrontClient = async ({ accountId, externalId, roleName }) => {
    const assumed = await assumeConnectorRole({ accountId, externalId, roleName });
    return {
      ...assumed,
      cloudFrontClient: new CloudFrontEdgeClient({ credentials: assumed.credentials }),
    };
  };

  // Caller identity for audit lines; defaults so the field is always present (mirrors Cloudflare).
  const getCallerId = (context) => context?.attributes?.authInfo?.getProfile?.()?.email || 'unknown';

  // Greppable key=value audit line per mutation (started/done/error), correlated by requestId —
  // same shape as the Cloudflare onboarding controller. Null/empty fields are dropped.
  const auditLine = (context, action, outcome, fields = {}) => {
    const entries = {
      action,
      outcome,
      caller: getCallerId(context),
      requestId: context?.invocation?.id || 'unknown',
      ...fields,
    };
    const fmt = (v) => {
      const s = String(v);
      return /\s/.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
    };
    const kv = Object.entries(entries)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(' ');
    return `[cdn-onboard-cloudfront] ${kv}`;
  };

  // Surface actionable AWS failures (permissions, preconditions, throttling) as 4xx instead of a
  // generic 500 + "try again", which hides the cause and invites a blind retry.
  const CATEGORIZED_AWS_ERRORS = new Set([
    'AccessDenied', 'AccessDeniedException', 'PreconditionFailed',
    'ThrottlingException', 'TooManyRequestsException', 'InvalidArgument', 'NoSuchDistribution',
  ]);
  const mutationErrorResponse = (error, fallbackMessage) => (
    CATEGORIZED_AWS_ERRORS.has(error?.name)
      ? badRequest(cleanupHeaderValue(`${error.name}: ${error.message}`))
      : internalServerError(fallbackMessage)
  );

  // Guardrail: a mutation may only touch a distribution that serves this site — allow only when the
  // site host is among the distribution's CNAMEs (Aliases), else block (explicit override aside).
  // Returns `{ error }` (badRequest) on a block, `{}` when allowed.
  const assertDistributionServesSite = async (
    cloudFrontClient,
    distributionId,
    site,
    context,
    log,
  ) => {
    const baseURL = site.getBaseURL();
    // Match www-insensitively (x.com ≡ www.x.com) against both the site baseURL and its
    // overrideBaseURL, so apex-only, www-only, and both-CNAME distributions all resolve correctly.
    const siteRoots = new Set();
    for (const url of [baseURL, effectiveBaseURL(site)]) {
      try {
        siteRoots.add(getHostnameWithoutWww(url, log));
      } catch (e) {
        // unparseable URL — skip; if no root resolves, the guard falls through to the warning
      }
    }

    const distributions = await cloudFrontClient.listDistributions();
    const dist = distributions.find((d) => d.id === distributionId);
    if (!dist) {
      return { error: badRequest(`Distribution ${distributionId} not found in this account`) };
    }
    const aliases = dist.aliases.map((a) => a.toLowerCase());
    const aliasServesSite = aliases.some((a) => {
      try {
        return siteRoots.has(getHostnameWithoutWww(a, log));
      } catch (e) {
        return false;
      }
    });
    if (aliasServesSite) {
      return {};
    }

    let siteHost = baseURL;
    try {
      siteHost = new URL(effectiveBaseURL(site)).host;
    } catch (e) {
      // keep baseURL as the display value
    }
    const allowOverride = context.data?.allowDomainMismatch === true;
    if (allowOverride) {
      log.warn(`[cdn-onboard-cloudfront] OVERRIDE site ${site.getId()}: distribution `
        + `${distributionId} (aliases: ${aliases.join(',') || 'none'}) does not serve `
        + `${siteHost} — proceeding by explicit override`);
      return {};
    }
    return {
      error: badRequest(`Distribution ${distributionId} does not serve ${siteHost}`
        + ` (its domains: ${aliases.join(', ') || 'none'}).`
        + ' Select the CloudFront distribution that serves this site.'),
    };
  };

  // Verify the customer's cross-account connector role is assumable. Used by the wizard's
  // "Allow access" step, which polls this after the customer creates the role via CloudFormation.
  const connect = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const { accountId, externalId, error: credError } = validateCloudfrontCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'connect the CloudFront connector role');
      if (error) {
        return error;
      }

      try {
        const { roleArn } = await assumeConnectorRole({ accountId, externalId, roleName });
        log.info(`[cdn-onboard-cloudfront] Connected site ${siteId} to account ${accountId}`);
        return ok({ connected: true, accountId, roleArn });
      } catch (assumeError) {
        // The role may not exist yet (customer still creating it) or the external ID may not
        // match — surface as not-connected so the wizard can keep polling rather than erroring.
        log.info(`[cdn-onboard-cloudfront] Role not yet assumable for site ${siteId}: ${assumeError.message}`);
        return ok({ connected: false, reason: cleanupHeaderValue(assumeError.message) });
      }
    } catch (error) {
      log.error(`Failed to connect CloudFront connector role for site ${siteId}:`, error);
      return internalServerError('Failed to connect the CloudFront connector role, please try again');
    }
  };

  // List the customer's CloudFront distributions (read-only) via the connector role, so the
  // wizard's "Choose distribution" step can let the customer pick one to configure.
  const listDistributions = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const { accountId, externalId, error: credError } = validateCloudfrontCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'list CloudFront distributions');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const distributions = await cloudFrontClient.listDistributions();
      return ok({ distributions });
    } catch (error) {
      log.error(`Failed to list CloudFront distributions for site ${siteId}:`, error);
      return internalServerError('Failed to list CloudFront distributions, please try again');
    }
  };

  // Run the wizard's pre-flight checks: confirm the connector role is assumable and that it grants
  // CloudFront read access. Each check reports ok/false individually so the wizard can show a
  // per-check status rather than failing the whole step on a single problem.
  const checkPrerequisites = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const { accountId, externalId, error: credError } = validateCloudfrontCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'check CloudFront prerequisites');
      if (error) {
        return error;
      }

      const connectorRoleCheck = { name: 'connectorRole', ok: true };
      const cloudFrontReadCheck = { name: 'cloudFrontRead', ok: true };

      try {
        const { cloudFrontClient } = await assumeCloudFrontClient({
          accountId, externalId, roleName,
        });
        try {
          await cloudFrontClient.listDistributions();
        } catch (listError) {
          cloudFrontReadCheck.ok = false;
          cloudFrontReadCheck.detail = cleanupHeaderValue(listError.message);
        }
      } catch (assumeError) {
        connectorRoleCheck.ok = false;
        connectorRoleCheck.detail = cleanupHeaderValue(assumeError.message);
        // Can't read CloudFront without the role, so mark it failed too.
        cloudFrontReadCheck.ok = false;
        cloudFrontReadCheck.detail = 'connector role not assumable';
      }

      // TODO: also validate the Edge Optimize API key here (was part of the standalone wizard).
      return ok({ checks: [connectorRoleCheck, cloudFrontReadCheck] });
    } catch (error) {
      log.error(`Failed to check CloudFront prerequisites for site ${siteId}:`, error);
      return internalServerError('Failed to check CloudFront prerequisites, please try again');
    }
  };

  // Read the origins configured on a customer's CloudFront distribution so the wizard's
  // "Review origins" step can show them and flag whether an Edge Optimize origin already exists.
  const fetchOrigins = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read CloudFront origins');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const { origins } = await cloudFrontClient.getDistributionConfig(distributionId);
      const hasEdgeOptimizeOrigin = origins.some((origin) => /edgeoptimize/i.test(origin.id)
        || /edgeoptimize/i.test(origin.domainName || ''));
      return ok({ origins, hasEdgeOptimizeOrigin });
    } catch (error) {
      log.error(`Failed to read CloudFront origins for site ${siteId}:`, error);
      return internalServerError('Failed to read CloudFront origins, please try again');
    }
  };

  // Read the cache behaviors (default + ordered) configured on a customer's CloudFront
  // distribution so the wizard's "Review routing" step can show how traffic is currently routed.
  const fetchBehaviors = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read CloudFront behaviors');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const { defaultCacheBehavior, cacheBehaviors } = await cloudFrontClient
        .getDistributionConfig(distributionId);
      const behaviors = [];
      if (defaultCacheBehavior) {
        behaviors.push({ ...defaultCacheBehavior, isDefault: true });
      }
      cacheBehaviors.forEach((behavior) => behaviors.push({ ...behavior, isDefault: false }));
      return ok({ behaviors });
    } catch (error) {
      log.error(`Failed to read CloudFront behaviors for site ${siteId}:`, error);
      return internalServerError('Failed to read CloudFront behaviors, please try again');
    }
  };

  // Resolve the Edge Optimize origin headers (apiKey + forwardedHost) and the baseURL the wizard
  // routes to, for the site being onboarded. The wizard is environment-agnostic: a stage domain is
  // just another onboarded LLMO site, so the caller invokes the wizard with that site's siteId and
  // this resolves against whatever site it is given (production or stage alike).
  //
  // Returns `{ target: { baseURL, apiKey, forwardedHost }, error }`. On any resolution failure
  // `error` is a badRequest Response the caller returns directly; otherwise `error` is undefined.
  const resolveEoTarget = async (context, site, log) => {
    const tokowakaClient = TokowakaClient.createFrom(context);

    const baseURL = site.getBaseURL();
    const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
    const apiKey = metaconfig?.apiKeys?.[0];
    if (!hasText(apiKey)) {
      return { error: badRequest('No LLMO API key found for this site') };
    }
    // Forwarded host must match what the Edge Optimize pipeline keyed content under, which honors
    // overrideBaseURL (apiKey lookup stays on baseURL to avoid affecting key resolution).
    const forwardedHost = calculateForwardedHost(effectiveBaseURL(site), log);
    return { target: { baseURL, apiKey, forwardedHost } };
  };

  // Add the Edge Optimize origin to the selected distribution (mutation). Idempotent: returns
  // { created: false, alreadyExisted: true } when the origin is already present. Used by the
  // wizard's "Create Edge Optimize origin" step.
  const createOrigin = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_EDGE_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'create the Edge Optimize origin');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the onboarded site (resolveEoTarget) — no UI input. Without
      // them Verify never goes green.
      const { target, error: targetError } = await resolveEoTarget(context, site, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }
      log.info(auditLine(context, 'create-origin', 'started', { siteId, accountId, distributionId }));
      const result = await cloudFrontClient.createOrigin(
        distributionId,
        originDomain,
        { apiKey, forwardedHost },
      );
      let resultLabel = 'exists';
      if (result.created) {
        resultLabel = 'created';
      } else if (result.updated) {
        resultLabel = 'updated';
      }
      log.info(auditLine(context, 'create-origin', 'done', {
        siteId, accountId, distributionId, result: resultLabel,
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'create-origin', 'error', {
        siteId, accountId, distributionId, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to create the Edge Optimize origin, please try again');
    }
  };

  // Create/update + publish the `edgeoptimize-routing` CloudFront Function (mutation, idempotent).
  // Needs the default-behavior target origin id so the function's failover origin group is correct.
  const createRoutingFunction = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const targetedPaths = Array.isArray(context.data?.targetedPaths)
      ? context.data.targetedPaths
      : null;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    // targetedPaths is embedded into the CloudFront Function as JSON (not interpolated), so this is
    // a sanity/size guard, not an injection fix: cap the count (short testing list) and check each
    // entry is a clean path.
    if (targetedPaths !== null) {
      if (targetedPaths.length > TARGETED_PATHS_MAX_ENTRIES) {
        return badRequest(`targetedPaths supports at most ${TARGETED_PATHS_MAX_ENTRIES} paths`);
      }
      const validEntries = targetedPaths.every((p) => typeof p === 'string'
        && p.length > 0 && p.length <= TARGETED_PATHS_MAX_ENTRY_LENGTH
        && /^[a-zA-Z0-9/_.*-]+$/.test(p));
      if (!validEntries) {
        return badRequest('Each targetedPaths entry must be a non-empty path'
          + ` (max ${TARGETED_PATHS_MAX_ENTRY_LENGTH} chars; alphanumerics and / _ . * - only)`);
      }
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'create the CloudFront routing function');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }
      // Derive the default-behavior target origin id from the live distribution config.
      const { defaultCacheBehavior } = await cloudFrontClient.getDistributionConfig(distributionId);
      const defaultOriginId = defaultCacheBehavior?.targetOriginId;
      if (!hasText(defaultOriginId)) {
        return badRequest('Could not determine the default cache behavior target origin');
      }

      log.info(auditLine(context, 'create-function', 'started', { siteId, accountId, distributionId }));
      const result = await cloudFrontClient.createCloudFrontFunction(
        defaultOriginId,
        distributionId,
        targetedPaths,
      );
      log.info(auditLine(context, 'create-function', 'done', {
        siteId, accountId, distributionId, created: result.created,
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'create-function', 'error', {
        siteId, accountId, distributionId, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to create the CloudFront routing function, please try again');
    }
  };

  // Ensure the Edge Optimize headers are forwarded by the selected behavior's cache policy
  // (mutation, idempotent). Used by the wizard's "Apply cache headers" step.
  const applyCache = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const pathPattern = String(context.data?.pathPattern || '').trim() || 'default';
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'apply CloudFront cache headers');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }
      log.info(auditLine(context, 'apply-cache', 'started', {
        siteId, accountId, distributionId, behavior: pathPattern,
      }));
      const result = await cloudFrontClient.updateCacheSettings(distributionId, pathPattern);
      log.info(auditLine(context, 'apply-cache', 'done', {
        siteId, accountId, distributionId, behavior: pathPattern, scenario: result.scenario,
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'apply-cache', 'error', {
        siteId, accountId, distributionId, behavior: pathPattern, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to apply CloudFront cache headers, please try again');
    }
  };

  // Create/update + publish the `edgeoptimize-origin` Lambda@Edge function and its exec role
  // (mutation, idempotent). Returns the versioned ARN the associate step needs.
  const createLambda = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'create the CloudFront Lambda@Edge function');
      if (error) {
        return error;
      }

      const {
        cloudFrontClient,
        accountId: resolvedAccountId,
      } = await assumeCloudFrontClient({ accountId, externalId, roleName });
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }
      log.info(auditLine(context, 'create-lambda', 'started', { siteId, accountId, distributionId }));
      const result = await cloudFrontClient.createLambdaAtEdge(
        resolvedAccountId,
        { distributionId },
      );
      log.info(auditLine(context, 'create-lambda', 'done', {
        siteId, accountId, distributionId, status: result.status, version: result.version,
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'create-lambda', 'error', {
        siteId, accountId, distributionId, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to create the CloudFront Lambda@Edge function, please try again');
    }
  };

  // Read-only status for the Lambda@Edge function so the wizard can detect on entry (and poll
  // after a slow/timed-out create) whether it already exists with a published version.
  const fetchLambdaStatus = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read the CloudFront Lambda@Edge status');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const status = await cloudFrontClient.getLambdaAtEdgeStatus(distributionId);
      return ok(status);
    } catch (error) {
      log.error(`Failed to read Lambda@Edge status for site ${siteId}:`, error);
      return internalServerError('Failed to read the CloudFront Lambda@Edge status, please try again');
    }
  };

  // Associate the routing CloudFront Function (viewer-request) and Lambda@Edge (origin-request/
  // response, versioned ARN) onto the user-selected behavior (mutation). Used by "Associate".
  const applyAssociations = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const pathPattern = String(context.data?.pathPattern || '').trim() || 'default';
    const lambdaVersionArn = String(context.data?.lambdaVersionArn || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (!hasText(lambdaVersionArn)) {
      return badRequest('lambdaVersionArn is required');
    }
    // Lambda@Edge requires a published, versioned function ARN in us-east-1; the account segment
    // must also match the caller's AWS account so we never associate a function from elsewhere.
    const lambdaEdgeArnPattern = /^arn:aws:lambda:us-east-1:\d{12}:function:[A-Za-z0-9_-]+:\d+$/;
    if (!lambdaEdgeArnPattern.test(lambdaVersionArn)
      || lambdaVersionArn.split(':')[4] !== accountId) {
      return badRequest('lambdaVersionArn must be a versioned us-east-1 Lambda ARN');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'associate CloudFront routing');
      if (error) {
        return error;
      }

      const { cloudFrontClient } = await assumeCloudFrontClient({
        accountId, externalId, roleName,
      });
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }
      log.info(auditLine(context, 'associate', 'started', {
        siteId, accountId, distributionId, behavior: pathPattern,
      }));
      const result = await cloudFrontClient.applyAssociations(
        distributionId,
        pathPattern,
        lambdaVersionArn,
      );
      log.info(auditLine(context, 'associate', 'done', {
        siteId, accountId, distributionId, behavior: pathPattern,
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'associate', 'error', {
        siteId, accountId, distributionId, behavior: pathPattern, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to associate CloudFront routing, please try again');
    }
  };

  // Verify end-to-end routing by probing the distribution as a bot vs a human and inspecting the
  // x-edgeoptimize-* headers. Always returns 200 with { passed }; success requires a request-id.
  const verifyRouting = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'verify CloudFront routing');
      if (error) {
        return error;
      }

      // Probe the customer's REAL onboarded domain (the site's own host) — that is where bot
      // traffic actually lands, so it is the true end-to-end test of the routing. An explicit
      // `domain` override still wins; the distribution's *.cloudfront.net DomainName is only a
      // last-resort fallback for distributions with no resolvable site host.
      let domain = String(context.data?.domain || '').trim();
      if (!hasText(domain)) {
        try {
          domain = String(calculateForwardedHost(effectiveBaseURL(site), log) || '').trim();
        } catch (e) {
          log.warn(`[cdn-onboard-cloudfront] could not derive host from site baseURL: ${e.message}`);
        }
      }
      if (!hasText(domain)) {
        const { cloudFrontClient } = await assumeCloudFrontClient({
          accountId, externalId, roleName,
        });
        const distributions = await cloudFrontClient.listDistributions();
        const match = distributions.find((d) => d.id === distributionId);
        domain = match?.domainName || '';
      }
      if (!hasText(domain)) {
        return badRequest('Could not determine the domain to verify');
      }

      const url = /^https?:\/\//.test(domain) ? domain : `https://${domain}/`;
      const result = await verifyAwsRouting(url);
      log.info(`[cdn-onboard-cloudfront] Verified routing for site ${siteId}: passed=${result.passed}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to verify CloudFront routing for site ${siteId}:`, error);
      return internalServerError('Failed to verify CloudFront routing, please try again');
    }
  };

  // Idempotent, step-on-poll orchestrator for the CloudFront "Deploy routing" wizard. The FE calls
  // this once then polls it (~30s); each call advances origin → function → cache → lambda →
  // associate → verify as far as it safely can (well under the gateway's ~60s timeout) and returns
  // per-step status. Safe to call repeatedly — gated steps never re-mutate completed work. The FE
  // passes the customer's selected distribution, failover origin, and behavior explicitly; the EO
  // API key + forwarded host are derived server-side from the site (no UI input).
  const deploy = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const originId = String(context.data?.originId || '').trim();
    const behavior = String(context.data?.behavior || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_EDGE_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'deploy CloudFront routing');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the onboarded site (resolveEoTarget) — no UI input. Without
      // them Verify never goes green.
      const { target, error: targetError } = await resolveEoTarget(context, site, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      // Assume the connector role ONCE; all steps run with the same short-lived credentials.
      const {
        cloudFrontClient,
        accountId: resolvedAccountId,
      } = await assumeCloudFrontClient({ accountId, externalId, roleName });

      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return guard.error;
      }

      log.info(auditLine(context, 'deploy', 'started', {
        siteId, accountId, distributionId, behavior,
      }));
      const result = await cloudFrontClient.runDeployStep({
        distributionId,
        originId,
        behavior,
        originDomain,
        originHeaders: { apiKey, forwardedHost },
        accountId: resolvedAccountId,
      });

      log.info(auditLine(context, 'deploy', 'done', {
        siteId,
        accountId,
        distributionId,
        behavior,
        routingDeployed: result.routingDeployed,
        verified: result.verified,
        steps: result.steps.map((s) => `${s.key}:${s.status}`).join(','),
      }));
      return ok(result);
    } catch (error) {
      log.error(auditLine(context, 'deploy', 'error', {
        siteId, accountId, distributionId, behavior, error: error.message,
      }));
      return mutationErrorResponse(error, 'Failed to deploy CloudFront routing, please try again');
    }
  };

  // Read-only "preview" for the wizard's "Review & Deploy" screen. Mirrors the deploy handler (same
  // validation + gate + role assumption + server-derived EO origin headers), but calls the
  // NON-mutating planDeploy and returns the per-step plan + canProceed/blocker so the
  // FE can show exactly what will happen before the customer commits.
  const plan = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const originId = String(context.data?.originId || '').trim();
    const behavior = String(context.data?.behavior || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_EDGE_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = validateCloudfrontCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'preview CloudFront routing');
      if (error) {
        return error;
      }

      // Derive the EO origin headers server-side (same as deploy, via resolveEoTarget) so the
      // origin step of the plan reflects whether the existing origin already carries them.
      const { target, error: targetError } = await resolveEoTarget(context, site, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      const {
        cloudFrontClient,
        accountId: resolvedAccountId,
      } = await assumeCloudFrontClient({ accountId, externalId, roleName });

      // Dry-run: a distribution that doesn't serve this site surfaces as a blocker (not a hard
      // error) so the review screen explains it and keeps Deploy disabled.
      const guard = await assertDistributionServesSite(
        cloudFrontClient,
        distributionId,
        site,
        context,
        log,
      );
      if (guard.error) {
        return ok({
          canProceed: false,
          blocker: `Distribution ${distributionId} does not serve ${forwardedHost}.`
            + ' Select the CloudFront distribution that serves this site.',
          steps: [],
        });
      }

      const result = await cloudFrontClient.planDeploy({
        distributionId,
        originId,
        behavior,
        originDomain,
        originHeaders: { apiKey, forwardedHost },
        accountId: resolvedAccountId,
      });

      log.info(`[cdn-onboard-cloudfront] site ${siteId}: canProceed=${result.canProceed},`
        + ` steps=${result.steps.map((s) => `${s.key}:${s.action}`).join(',')}`);
      // targetDomain lets the FE display exactly the host the BE will route to for this site.
      // Loosely coupled: the FE also knows it locally, so this is purely informational.
      return ok({ ...result, targetDomain: forwardedHost });
    } catch (error) {
      log.error(`[cdn-onboard-cloudfront] Failed for site ${siteId}:`, error);
      return internalServerError('Failed to preview CloudFront routing, please try again');
    }
  };

  /**
   * GET /sites/{siteId}/llmo/cdn-onboard/cloudfront/permissions
   * Powers the wizard's "View Permissions" panel. Returns a curated, human-friendly manifest of the
   * AWS permissions the connector role grants (read from a static JSON object in the template S3
   * bucket) plus the Adobe principal ARN that will assume the role. Read-only — gated on site
   * access + LLMO admin (like createBootstrapUrl). No cross-account calls.
   * @param {object} context - Request context
   * @returns {Promise<Response>} { adobeAccount, manifest } or a 400 on a config/read failure.
   */
  const getPermissions = async (context) => {
    const {
      log, dataAccess, env, s3,
    } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'view the CloudFront connector permissions');
      if (error) {
        return error;
      }

      const bucket = env.SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET;
      if (!hasText(bucket) || !s3?.s3Client || !s3?.GetObjectCommand) {
        return badRequest('CloudFront template hosting is not configured for this environment');
      }
      // SINGLE SOURCE OF TRUTH: read the high-level permission summary from the connector role
      // template's Metadata block — the same file (and the same S3 object) that defines the actual
      // IAM policy — so the displayed permissions can never drift from what the role grants.
      const key = env.EDGE_OPTIMIZE_TEMPLATE_KEY || 'customer-bootstrap-role.yaml';

      // The Adobe principal that assumes the connector role — per-environment, from Vault
      // (dx_mysticat/<env>/api-service.SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN).
      const adobeAccount = env.SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN;
      if (!hasText(adobeAccount)) {
        return badRequest('CloudFront connector is not configured for this environment (missing trusted principal)');
      }

      const response = await s3.s3Client.send(new s3.GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }));
      const body = await response.Body.transformToString();
      const doc = yaml.load(body, { schema: CFN_YAML_SCHEMA });
      const perms = doc?.Metadata?.AdobeLLMOptimizerPermissions;
      if (!Array.isArray(perms?.groups) || perms.groups.length === 0) {
        throw new Error('connector template has no AdobeLLMOptimizerPermissions metadata');
      }
      // Map the template's {name, scope, summary} groups to the UI's {name, items[]} shape.
      const manifest = {
        appName: perms.appName || 'Adobe LLM Optimizer',
        groups: perms.groups.map((g) => ({
          name: g.name,
          items: [g.scope ? `Scoped to ${g.scope}` : null, g.summary].filter(Boolean),
        })),
      };

      log.info(`[cdn-onboard-cloudfront] Returned permissions for site ${siteId}`);
      return ok({ adobeAccount, manifest });
    } catch (error) {
      log.error(`Failed to read the CloudFront connector permissions for site ${siteId}:`, error);
      return internalServerError('Failed to read the CloudFront connector permissions, please try again');
    }
  };

  return {
    createBootstrapUrl,
    connect,
    listDistributions,
    checkPrerequisites,
    fetchOrigins,
    fetchBehaviors,
    createOrigin,
    createRoutingFunction,
    applyCache,
    createLambda,
    fetchLambdaStatus,
    applyAssociations,
    verifyRouting,
    deploy,
    plan,
    getPermissions,
  };
}

export default LlmoCloudFrontController;
