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
import { hasText, composeBaseURL } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import crypto from 'crypto';
import yaml from 'js-yaml';
import TokowakaClient, {
  calculateForwardedHost,
  assumeConnectorRole,
  listCloudFrontDistributions,
  getDistributionConfig,
  createEdgeOptimizeOrigin,
  createEdgeOptimizeRoutingFunction,
  applyEdgeOptimizeCacheHeaders,
  createEdgeOptimizeLambda,
  getEdgeOptimizeLambdaStatus,
  applyEdgeOptimizeAssociations,
  verifyEdgeOptimizeRouting,
  runEdgeOptimizeDeployStep,
  planEdgeOptimizeDeploy,
} from '@adobe/spacecat-shared-tokowaka-client';
import AccessControlUtil from '../../support/access-control-util.js';

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
        return forbidden('Only LLMO administrators can generate the edge optimize bootstrap URL');
      }

      // The template-hosting S3 bucket — per-environment, from Vault
      // (dx_mysticat/<env>/api-service.EDGE_OPTIMIZE_TEMPLATE_BUCKET). Lives in the same account
      // the service deploys/signs in, so it is read same-account; the customer fetches via presign.
      const bucket = env.EDGE_OPTIMIZE_TEMPLATE_BUCKET;
      if (!hasText(bucket) || !s3?.s3Client) {
        return badRequest('Edge optimize template hosting is not configured for this environment');
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
      // from Vault (dx_mysticat/<env>/api-service.EDGE_OPTIMIZE_TRUSTED_PRINCIPAL_ARN).
      const trustedPrincipalArn = env.EDGE_OPTIMIZE_TRUSTED_PRINCIPAL_ARN;
      if (!hasText(trustedPrincipalArn)) {
        return badRequest('Edge optimize is not configured for this environment (missing trusted principal)');
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

      log.info(`[edge-optimize-bootstrap-url] Generated bootstrap URL for site ${siteId}, account ${accountId}`);

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
      log.error(`Failed to generate edge optimize bootstrap URL for site ${siteId}:`, error);
      return internalServerError('Failed to generate the edge optimize bootstrap URL, please try again');
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
  const parseEoCredentials = (context, { requireDistribution = false } = {}) => {
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
    return { accountId, externalId, distributionId };
  };

  // Verify the customer's cross-account connector role is assumable. Used by the wizard's
  // "Allow access" step, which polls this after the customer creates the role via CloudFormation.
  const connect = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const { accountId, externalId, error: credError } = parseEoCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'connect the edge optimize role');
      if (error) {
        return error;
      }

      try {
        const { roleArn } = await assumeConnectorRole({ accountId, externalId, roleName });
        log.info(`[edge-optimize-connect] Connected site ${siteId} to account ${accountId}`);
        return ok({ connected: true, accountId, roleArn });
      } catch (assumeError) {
        // The role may not exist yet (customer still creating it) or the external ID may not
        // match — surface as not-connected so the wizard can keep polling rather than erroring.
        log.info(`[edge-optimize-connect] Role not yet assumable for site ${siteId}: ${assumeError.message}`);
        return ok({ connected: false, reason: cleanupHeaderValue(assumeError.message) });
      }
    } catch (error) {
      log.error(`Failed to connect edge optimize role for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // List the customer's CloudFront distributions (read-only) via the connector role, so the
  // wizard's "Choose distribution" step can let the customer pick one to configure.
  const listDistributions = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    const { accountId, externalId, error: credError } = parseEoCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'list CloudFront distributions');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const distributions = await listCloudFrontDistributions(credentials);
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

    const { accountId, externalId, error: credError } = parseEoCredentials(context);
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'check edge optimize prerequisites');
      if (error) {
        return error;
      }

      const connectorRoleCheck = { name: 'connectorRole', ok: true };
      const cloudFrontReadCheck = { name: 'cloudFrontRead', ok: true };

      try {
        const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
        try {
          await listCloudFrontDistributions(credentials);
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
      log.error(`Failed to check edge optimize prerequisites for site ${siteId}:`, error);
      return internalServerError('Failed to check edge optimize prerequisites, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read CloudFront origins');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const { origins } = await getDistributionConfig(credentials, distributionId);
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read CloudFront behaviors');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const { defaultCacheBehavior, cacheBehaviors } = await getDistributionConfig(
        credentials,
        distributionId,
      );
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

  // Single source of environment-awareness for the CloudFront wizard. The FE sends only an optional
  // `environment` flag ('production' | 'stage'); the BE does ALL resolution here and returns the EO
  // origin headers (apiKey + forwardedHost) plus the resolved baseURL the wizard will route to.
  //
  // - 'production' / absent → today's behavior: prod site baseURL → first metaconfig apiKey +
  //   calculateForwardedHost(prod baseURL).
  // - 'stage' → resolve the single stage domain persisted on the prod site's edgeOptimizeConfig
  //   (stagingDomains[0]); compose its baseURL; look up the (already-onboarded) stage site; use
  //   that stage site's first metaconfig apiKey + calculateForwardedHost(stage baseURL).
  //
  // Returns `{ target: { baseURL, apiKey, forwardedHost }, error }`. On any resolution failure
  // `error` is a badRequest Response the caller returns directly; otherwise `error` is undefined.
  const resolveEoTarget = async (context, site, environment, log) => {
    const { Site } = context.dataAccess;
    const tokowakaClient = TokowakaClient.createFrom(context);

    if (environment === 'stage') {
      const edgeConfig = site.getConfig().getEdgeOptimizeConfig() || {};
      const stagingDomains = Array.isArray(edgeConfig.stagingDomains)
        ? edgeConfig.stagingDomains
        : [];
      const stageDomain = String(stagingDomains[0]?.domain || '').trim();
      if (!hasText(stageDomain)) {
        return { error: badRequest('No stage domain configured for this site') };
      }

      const stageBaseURL = composeBaseURL(stageDomain);
      const stageSite = await Site.findByBaseURL(stageBaseURL);
      if (!stageSite) {
        return { error: badRequest('Stage site not found — add the stage domain first') };
      }

      const metaconfig = await tokowakaClient.fetchMetaconfig(stageBaseURL);
      const apiKey = metaconfig?.apiKeys?.[0];
      if (!hasText(apiKey)) {
        return {
          error: badRequest('Stage site has no Edge Optimize API key'
            + ' — enable Edge Optimize for the stage domain first'),
        };
      }
      const forwardedHost = calculateForwardedHost(stageBaseURL, log);
      return { target: { baseURL: stageBaseURL, apiKey, forwardedHost } };
    }

    // production / absent
    const baseURL = site.getBaseURL();
    const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
    const apiKey = metaconfig?.apiKeys?.[0];
    if (!hasText(apiKey)) {
      return {
        error: badRequest('Site has no Edge Optimize API key'
          + ' — enable Edge Optimize for this site first'),
      };
    }
    const forwardedHost = calculateForwardedHost(baseURL, log);
    return { target: { baseURL, apiKey, forwardedHost } };
  };

  // Add the Edge Optimize origin to the selected distribution (mutation). Idempotent: returns
  // { created: false, alreadyExisted: true } when the origin is already present. Used by the
  // wizard's "Create Edge Optimize origin" step.
  const createOrigin = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const environment = String(context.data?.environment || 'production').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (environment !== 'production' && environment !== 'stage') {
      return badRequest("environment must be 'production' or 'stage'");
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'create the edge optimize origin');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the site (env-aware via resolveEoTarget) — no UI input beyond
      // the optional `environment` flag. Without them Verify never goes green.
      const { target, error: targetError } = await resolveEoTarget(context, site, environment, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const result = await createEdgeOptimizeOrigin(
        credentials,
        distributionId,
        originDomain,
        { apiKey, forwardedHost },
      );
      let action = 'Origin already existed for';
      if (result.created) {
        action = 'Created origin for';
      } else if (result.updated) {
        action = 'Patched origin headers for';
      }
      log.info(`[edge-optimize-origin] ${action} site ${siteId}, distribution ${distributionId}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to create CloudFront Edge Optimize origin for site ${siteId}:`, error);
      return internalServerError('Failed to create the edge optimize origin, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'create the edge optimize routing function');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      // Derive the default-behavior target origin id from the live distribution config.
      const { defaultCacheBehavior } = await getDistributionConfig(credentials, distributionId);
      const defaultOriginId = defaultCacheBehavior?.targetOriginId;
      if (!hasText(defaultOriginId)) {
        return badRequest('Could not determine the default cache behavior target origin');
      }

      const result = await createEdgeOptimizeRoutingFunction(
        credentials,
        defaultOriginId,
        distributionId,
        targetedPaths,
      );
      log.info(`[edge-optimize-function] ${result.created ? 'Created' : 'Updated'} routing function for site ${siteId}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to create CloudFront routing function for site ${siteId}:`, error);
      return internalServerError('Failed to create the edge optimize routing function, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'apply edge optimize cache headers');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const result = await applyEdgeOptimizeCacheHeaders(credentials, distributionId, pathPattern);
      log.info(`[edge-optimize-cache] Applied cache headers for site ${siteId}, behavior ${pathPattern}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to apply CloudFront cache headers for site ${siteId}:`, error);
      return internalServerError('Failed to apply edge optimize cache headers, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'create the edge optimize Lambda@Edge function');
      if (error) {
        return error;
      }

      const { credentials, accountId: resolvedAccountId } = await assumeConnectorRole({
        accountId, externalId, roleName,
      });
      const result = await createEdgeOptimizeLambda(
        credentials,
        resolvedAccountId,
        { distributionId },
      );
      log.info(`[edge-optimize-lambda] ${result.created ? 'Created' : 'Updated'} Lambda@Edge for site ${siteId}, published version ${result.version}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to create Lambda@Edge function for site ${siteId}:`, error);
      return internalServerError('Failed to create the edge optimize Lambda@Edge function, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'read the edge optimize Lambda@Edge status');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const status = await getEdgeOptimizeLambdaStatus(credentials, distributionId);
      return ok(status);
    } catch (error) {
      log.error(`Failed to read Lambda@Edge status for site ${siteId}:`, error);
      return internalServerError('Failed to read the edge optimize Lambda@Edge status, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
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
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'associate edge optimize routing');
      if (error) {
        return error;
      }

      const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
      const result = await applyEdgeOptimizeAssociations(
        credentials,
        distributionId,
        pathPattern,
        lambdaVersionArn,
      );
      log.info(`[edge-optimize-associate] Associated routing for site ${siteId}, behavior ${pathPattern}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to associate CloudFront routing for site ${siteId}:`, error);
      return internalServerError('Failed to associate edge optimize routing, please try again');
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
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'verify edge optimize routing');
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
          domain = String(calculateForwardedHost(site.getBaseURL(), log) || '').trim();
        } catch (e) {
          log.warn(`[edge-optimize-verify] could not derive host from site baseURL: ${e.message}`);
        }
      }
      if (!hasText(domain)) {
        const { credentials } = await assumeConnectorRole({ accountId, externalId, roleName });
        const distributions = await listCloudFrontDistributions(credentials);
        const match = distributions.find((d) => d.id === distributionId);
        domain = match?.domainName || '';
      }
      if (!hasText(domain)) {
        return badRequest('Could not determine the domain to verify');
      }

      const url = /^https?:\/\//.test(domain) ? domain : `https://${domain}/`;
      const result = await verifyEdgeOptimizeRouting(url);
      log.info(`[edge-optimize-verify] Verified routing for site ${siteId}: passed=${result.passed}`);
      return ok(result);
    } catch (error) {
      log.error(`Failed to verify CloudFront routing for site ${siteId}:`, error);
      return internalServerError('Failed to verify edge optimize routing, please try again');
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
    const environment = String(context.data?.environment || 'production').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }
    if (environment !== 'production' && environment !== 'stage') {
      return badRequest("environment must be 'production' or 'stage'");
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'deploy edge optimize routing');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the site (env-aware via resolveEoTarget) — no UI input beyond
      // the optional `environment` flag. Without them Verify never goes green.
      const { target, error: targetError } = await resolveEoTarget(context, site, environment, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      // Assume the connector role ONCE; all steps run with the same short-lived credentials.
      const { credentials, accountId: resolvedAccountId } = await assumeConnectorRole({
        accountId, externalId, roleName,
      });

      const result = await runEdgeOptimizeDeployStep(credentials, {
        distributionId,
        originId,
        behavior,
        originDomain,
        originHeaders: { apiKey, forwardedHost },
        accountId: resolvedAccountId,
      });

      log.info(`[edge-optimize-deploy] site ${siteId}: routingDeployed=${result.routingDeployed},`
        + ` verified=${result.verified}, steps=${result.steps.map((s) => `${s.key}:${s.status}`).join(',')}`);
      return ok(result);
    } catch (error) {
      log.error(`[edge-optimize-deploy] Failed for site ${siteId}:`, error);
      return internalServerError('Failed to deploy edge optimize routing, please try again');
    }
  };

  // Read-only "preview" for the wizard's "Review & Deploy" screen. Mirrors the deploy handler (same
  // validation + gate + role assumption + server-derived EO origin headers), but calls the
  // NON-mutating planEdgeOptimizeDeploy and returns the per-step plan + canProceed/blocker so the
  // FE can show exactly what will happen before the customer commits.
  const plan = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const originId = String(context.data?.originId || '').trim();
    const behavior = String(context.data?.behavior || '').trim();
    const environment = String(context.data?.environment || 'production').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    const {
      accountId, externalId, distributionId, error: credError,
    } = parseEoCredentials(context, { requireDistribution: true });
    if (credError) {
      return credError;
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }
    if (environment !== 'production' && environment !== 'stage') {
      return badRequest("environment must be 'production' or 'stage'");
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'preview edge optimize routing');
      if (error) {
        return error;
      }

      // Derive the EO origin headers server-side (same as deploy, env-aware via resolveEoTarget) so
      // the origin step of the plan reflects whether the existing origin already carries the right
      // headers for the chosen environment.
      const { target, error: targetError } = await resolveEoTarget(context, site, environment, log);
      if (targetError) {
        return targetError;
      }
      const { apiKey, forwardedHost } = target;

      const { credentials, accountId: resolvedAccountId } = await assumeConnectorRole({
        accountId, externalId, roleName,
      });

      const result = await planEdgeOptimizeDeploy(credentials, {
        distributionId,
        originId,
        behavior,
        originDomain,
        originHeaders: { apiKey, forwardedHost },
        accountId: resolvedAccountId,
      });

      log.info(`[edge-optimize-plan] site ${siteId}: canProceed=${result.canProceed},`
        + ` steps=${result.steps.map((s) => `${s.key}:${s.action}`).join(',')}`);
      // targetDomain lets the FE display exactly the host the BE will route to for this env.
      // Loosely coupled: the FE also knows it locally, so this is purely informational.
      return ok({ ...result, targetDomain: forwardedHost });
    } catch (error) {
      log.error(`[edge-optimize-plan] Failed for site ${siteId}:`, error);
      return internalServerError('Failed to preview edge optimize routing, please try again');
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
      const { error } = await gateEdgeOptimizeWizard(siteId, Site, 'view edge optimize permissions');
      if (error) {
        return error;
      }

      const bucket = env.EDGE_OPTIMIZE_TEMPLATE_BUCKET;
      if (!hasText(bucket) || !s3?.s3Client || !s3?.GetObjectCommand) {
        return badRequest('Edge optimize template hosting is not configured for this environment');
      }
      // SINGLE SOURCE OF TRUTH: read the high-level permission summary from the connector role
      // template's Metadata block — the same file (and the same S3 object) that defines the actual
      // IAM policy — so the displayed permissions can never drift from what the role grants.
      const key = env.EDGE_OPTIMIZE_TEMPLATE_KEY || 'customer-bootstrap-role.yaml';

      // The Adobe principal that assumes the connector role — per-environment, from Vault
      // (dx_mysticat/<env>/api-service.EDGE_OPTIMIZE_TRUSTED_PRINCIPAL_ARN).
      const adobeAccount = env.EDGE_OPTIMIZE_TRUSTED_PRINCIPAL_ARN;
      if (!hasText(adobeAccount)) {
        return badRequest('Edge optimize is not configured for this environment (missing trusted principal)');
      }

      let manifest;
      try {
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
        manifest = {
          appName: perms.appName || 'Adobe LLM Optimizer',
          groups: perms.groups.map((g) => ({
            name: g.name,
            items: [g.scope ? `Scoped to ${g.scope}` : null, g.summary].filter(Boolean),
          })),
        };
      } catch (s3Error) {
        log.error(`[edge-optimize-permissions] Failed to read permissions from connector template for site ${siteId}: ${s3Error.message}`);
        return badRequest('Edge optimize permissions are not available');
      }

      log.info(`[edge-optimize-permissions] Returned permissions for site ${siteId}`);
      return ok({ adobeAccount, manifest });
    } catch (error) {
      log.error(`Failed to read edge optimize permissions for site ${siteId}:`, error);
      return internalServerError('Failed to read edge optimize permissions, please try again');
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
