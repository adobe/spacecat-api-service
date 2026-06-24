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

import { gunzipSync } from 'zlib';
import {
  ok, created, badRequest, forbidden, createResponse, notFound, internalServerError,
  unauthorized,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isValidUUID,
  llmoConfig as llmo,
  llmoStrategy,
  schemas,
  composeBaseURL,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import crypto from 'crypto';
import { getDomain, parse as parseDomain } from 'tldts';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';
import TokowakaClient, { calculateForwardedHost } from '@adobe/spacecat-shared-tokowaka-client';
import { ImsClient } from '@adobe/spacecat-shared-ims-client';
import yaml from 'js-yaml';
import AccessControlUtil from '../../support/access-control-util.js';
import {
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
} from '../../support/edge-optimize.js';
import { UnauthorizedProductError } from '../../support/errors.js';
import { cachedOk } from '../../support/cached-response.js';
import {
  probeSiteAndResolveDomain,
  parseEdgeRoutingConfig,
  callCdnRoutingApi,
  EDGE_OPTIMIZE_CDN_STRATEGIES,
  SUPPORTED_EDGE_ROUTING_CDN_TYPES,
  OPTIMIZE_AT_EDGE_ENABLED_MARKING_TYPE,
  EDGE_OPTIMIZE_MARKING_DELAY_SECONDS,
  detectAemCsFastlyForDomain,
} from '../../support/edge-routing-utils.js';
import { triggerBrandProfileAgent } from '../../support/brand-profile-trigger.js';
import { getImsTokenFromPromiseToken, authorizeEdgeCdnRouting } from '../../support/edge-routing-auth.js';
import {
  applyFilters,
  applyInclusions,
  applyExclusions,
  applyGroups,
  applyMappings,
  CDN_TYPES,
  LLMO_SHEETDATA_SOURCE_URL,
} from './llmo-utils.js';
import { LLMO_SHEET_MAPPINGS } from './llmo-mappings.js';
import {
  validateSiteNotOnboarded,
  generateDataFolder,
  performLlmoOnboarding,
  performLlmoOffboarding,
  postLlmoAlert,
  appendRowsToQueryIndex,
  previewAndPublishQueryIndex,
} from './llmo-onboarding.js';
import { queryLlmoFiles } from './llmo-query-handler.js';
import {
  patchSheetRows,
  parseSheetRowPatch,
  sharepointPathFor,
  publishPathFor,
  isSafePathSegment,
} from './llmo-sheet-write.js';
import {
  fetchLlmoSource,
  llmoSourceErrorResponse,
  logNotProvisioned,
  EMPTY_SHEET_PAYLOAD,
  NOT_PROVISIONED_HEADER,
  NOT_PROVISIONED_VALUE,
} from './llmo-source.js';
import { updateModifiedByDetails } from './llmo-config-metadata.js';
import { notifyOptInIfNeeded } from './cdn-opt-in-notification.js';
import { handleLlmoRationale } from './llmo-rationale.js';
import { handleBrandClaims } from './brand-claims.js';
import { handleDemoBrandPresence, handleDemoRecommendations } from './opportunity-workspace-demo.js';
import { notifyStrategyChanges } from '../../support/opportunity-workspace-notifications.js';

const { readConfig, writeConfig } = llmo;
const { readStrategy, writeStrategy } = llmoStrategy;
const { llmoConfig: llmoConfigSchema } = schemas;

const IMS_ORG_ID_REGEX = /^[a-z0-9]{24}@AdobeOrg$/i;
const VALID_CADENCES = ['daily', 'weekly-paid', 'weekly-free'];

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

/** Site IDs for which HLX `brandpresence` sheet data is blocked (PG migration). */
const HLX_BRANDPRESENCE_PG_MIGRATION_SITE_IDS = new Set([
  '9ae8877a-bbf3-407d-9adb-d6a72ce3c5e3', // adobe.com Prod
  'c2473d89-e997-458d-a86d-b4096649c12b', // adobe.com Stage
  '59bdf35f-c0d4-4c51-9013-8a5b63d71eeb', // ekremney.com configured to use the adobe data folder for some reason
]);

const HLX_SHEET_DATA_PG_MIGRATION_FORBIDDEN_MESSAGE = 'Access to HLX sheet data has been blocked for this site due to PG migration';

function LlmoController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  // Helper function to get site and validate LLMO config
  const getSiteAndValidateLlmo = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site } = dataAccess;

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound(`Site not found: ${siteId}`);
    }
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    if (!llmoConfig?.dataFolder) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }
    let hasAccessToElmo;
    try {
      hasAccessToElmo = await accessControlUtil.hasAccess(
        site,
        '',
        EntitlementModel.PRODUCT_CODES.LLMO,
      );
    } catch (e) {
      // Product-code mismatch is an auth denial → 403. All other errors (e.g. entitlement
      // validation failures like "emailId is required") are business errors → rethrow so
      // callers' catch blocks return 400.
      if (e instanceof UnauthorizedProductError) {
        return forbidden(e.message);
      }
      throw e;
    }
    if (!hasAccessToElmo) {
      return forbidden('Only users belonging to the organization can view its sites');
    }
    return { site, config, llmoConfig };
  };

  // Helper function to save site config with error handling
  const saveSiteConfig = async (site, config, log, operation) => {
    site.setConfig(Config.toDynamoItem(config));
    try {
      await site.save();
    } catch (error) {
      log.error(`Error ${operation} for site's llmo config ${site.getId()}: ${error.message}`);
    }
  };

  // Helper function to validate question key
  const validateQuestionKey = (config, questionKey) => {
    const humanQuestions = config.getLlmoHumanQuestions() || [];
    const aiQuestions = config.getLlmoAIQuestions() || [];

    if (!humanQuestions.some((question) => question.key === questionKey)
      && !aiQuestions.some((question) => question.key === questionKey)) {
      throw new Error('Invalid question key, please provide a valid question key');
    }
  };

  // Helper function to validate customer intent key
  const validateCustomerIntentKey = (config, intentKey) => {
    const customerIntent = config.getLlmoCustomerIntent() || [];

    if (!customerIntent.some((intent) => intent.key === intentKey)) {
      throw new Error('Invalid customer intent key, please provide a valid customer intent key');
    }
  };

  /**
   * True when HLX sheet data must not be used: missing siteId, or PG-migrated site
   * requesting the `brandpresence` sheet type.
   * @param {Object} context - The context object
   * @returns {boolean}
   */
  const isHlxSheetDataAccessBlocked = (context) => {
    const { siteId, sheetType } = context.params;
    if (!siteId) {
      return true;
    }
    if (sheetType !== 'brand-presence') {
      return false;
    }
    return HLX_BRANDPRESENCE_PG_MIGRATION_SITE_IDS.has(siteId);
  };

  // Handles requests to the LLMO sheet data endpoint
  const getLlmoSheetData = async (context) => {
    const { log } = context;
    const {
      siteId, dataSource, sheetType, week,
    } = context.params;
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { llmoConfig } = siteValidation;
      if (isHlxSheetDataAccessBlocked(context)) {
        return forbidden(HLX_SHEET_DATA_PG_MIGRATION_FORBIDDEN_MESSAGE);
      }

      // Construct the sheet URL based on which parameters are provided
      let sheetURL;
      if (sheetType && week) {
        sheetURL = `${llmoConfig.dataFolder}/${sheetType}/${week}/${dataSource}.json`;
      } else if (sheetType) {
        sheetURL = `${llmoConfig.dataFolder}/${sheetType}/${dataSource}.json`;
      } else {
        sheetURL = `${llmoConfig.dataFolder}/${dataSource}.json`;
      }

      // Add limit, offset and sheet query params to the url
      const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);
      const { limit, offset, sheet } = context.data;
      if (limit) {
        url.searchParams.set('limit', limit);
      }
      if (offset) {
        url.searchParams.set('offset', offset);
      }
      // allow fetching a specific sheet from the sheet data source
      if (sheet) {
        url.searchParams.set('sheet', sheet);
      }

      // Fetch data from the external endpoint using the dataFolder from config
      const result = await fetchLlmoSource(context, url.toString());
      if (result.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      return cachedOk(result.data, { ...result.headers });
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message}`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles POST requests to the LLMO sheet data endpoint
  // with query capabilities (filtering, exclusions, grouping)
  const queryLlmoSheetData = async (context) => {
    const { log } = context;
    const {
      siteId, dataSource, sheetType, week,
    } = context.params;

    // Start timing for the entire method
    const methodStartTime = Date.now();

    const FIXED_LLMO_LIMIT = 1000000;

    // Extract and validate request body structure
    const {
      sheets = [],
      filters = {},
      include = [],
      exclude = [],
      groupBy = [],
      limit = FIXED_LLMO_LIMIT, // Default to 1M records to return all records
      offset = 0, // Default to 0 to return the first 1M records
    } = context.data || {};

    // Validate request body structure
    if (sheets && !Array.isArray(sheets)) {
      return badRequest('sheets must be an array');
    }

    if (filters && typeof filters !== 'object') {
      return badRequest('filters must be an object');
    }
    if (exclude && !Array.isArray(exclude)) {
      return badRequest('exclude must be an array');
    }
    if (groupBy && !Array.isArray(groupBy)) {
      return badRequest('groupBy must be an array');
    }
    if (include && !Array.isArray(include)) {
      return badRequest('include must be an array');
    }

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      if (isHlxSheetDataAccessBlocked(context)) {
        return forbidden(HLX_SHEET_DATA_PG_MIGRATION_FORBIDDEN_MESSAGE);
      }
      const { llmoConfig } = siteValidation;
      // Construct the sheet URL based on which parameters are provided
      let sheetURL;
      if (sheetType && week) {
        sheetURL = `${llmoConfig.dataFolder}/${sheetType}/${week}/${dataSource}.json`;
      } else if (sheetType) {
        sheetURL = `${llmoConfig.dataFolder}/${sheetType}/${dataSource}.json`;
      } else {
        sheetURL = `${llmoConfig.dataFolder}/${dataSource}.json`;
      }

      // Add limit, offset and sheet query params to the url
      const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);
      if (limit) {
        url.searchParams.set('limit', limit);
      }
      if (offset) {
        url.searchParams.set('offset', offset);
      }

      // Log setup completion time
      const setupTime = Date.now();
      log.info(`LLMO query setup completed - elapsed: ${setupTime - methodStartTime}ms`);

      // Fetch data from the external endpoint using the dataFolder from config
      const fetchStartTime = Date.now();
      const fetchResult = await fetchLlmoSource(context, url.toString());
      if (fetchResult.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return ok(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      let { data } = fetchResult;
      const responseHeaders = fetchResult.headers;
      const fetchEndTime = Date.now();
      const fetchDuration = fetchEndTime - fetchStartTime;
      log.info(`External API fetch completed - elapsed: ${fetchEndTime - methodStartTime}ms, duration: ${fetchDuration}ms`);

      // Keep only the required sheets
      if (sheets.length > 0 && (data[':type'] === 'multi-sheet')) {
        Object.keys(data).filter((key) => !key.startsWith(':')).forEach((key) => {
          if (sheets.indexOf(key) === -1) {
            delete data[key];
          }
        });
      }

      // Apply mappings using external configuration
      let mappingDuration = 0;
      log.info(`Looking for mapping for dataSource: ${dataSource} mappings ${JSON.stringify(LLMO_SHEET_MAPPINGS)}`);
      const mapping = LLMO_SHEET_MAPPINGS.find((m) => dataSource.toLowerCase().includes(m.pattern));
      if (mapping) {
        log.info(`Found mapping for dataSource: ${dataSource} mapping ${JSON.stringify(mapping)}`);
        const mappingStartTime = Date.now();
        data = applyMappings(data, mapping);
        const mappingEndTime = Date.now();
        mappingDuration = mappingEndTime - mappingStartTime;
        log.info(`Mapping completed - elapsed: ${mappingEndTime - methodStartTime}ms, duration: ${mappingDuration}ms`);
      }

      // Apply inclusions if any are provided
      let inclusionDuration = 0;
      if (Object.keys(include).length > 0) {
        const inclusionStartTime = Date.now();
        data = applyInclusions(data, include);
        const inclusionEndTime = Date.now();
        inclusionDuration = inclusionEndTime - inclusionStartTime;
        log.info(`Inclusion processing completed - elapsed: ${inclusionEndTime - methodStartTime}ms, duration: ${inclusionDuration}ms`);
      }

      // Apply filters if any are provided
      let filterDuration = 0;
      if (Object.keys(filters).length > 0) {
        const filterStartTime = Date.now();
        data = applyFilters(data, filters);
        const filterEndTime = Date.now();
        filterDuration = filterEndTime - filterStartTime;
        log.info(`Filtering completed - elapsed: ${filterEndTime - methodStartTime}ms, duration: ${filterDuration}ms`);
      }

      // Apply exclusions if any are provided
      let exclusionDuration = 0;
      if (exclude.length > 0) {
        const exclusionStartTime = Date.now();
        data = applyExclusions(data, exclude);
        const exclusionEndTime = Date.now();
        exclusionDuration = exclusionEndTime - exclusionStartTime;
        log.info(`Exclusion processing completed - elapsed: ${exclusionEndTime - methodStartTime}ms, duration: ${exclusionDuration}ms`);
      }

      // Apply grouping if any are provided
      let groupingDuration = 0;
      if (groupBy.length > 0) {
        const groupingStartTime = Date.now();
        data = applyGroups(data, groupBy);
        const groupingEndTime = Date.now();
        groupingDuration = groupingEndTime - groupingStartTime;
        log.info(`Grouping completed - elapsed: ${groupingEndTime - methodStartTime}ms, duration: ${groupingDuration}ms`);
      }

      // Log final completion time with summary
      const methodEndTime = Date.now();
      const totalDuration = methodEndTime - methodStartTime;
      log.info(`LLMO query completed - total duration: ${totalDuration}ms (fetch: ${fetchDuration}ms, inclusion: ${inclusionDuration}ms, filtering: ${filterDuration}ms, exclusion: ${exclusionDuration}ms, grouping: ${groupingDuration}ms, mapping: ${mappingDuration}ms)`);

      // Return the data, pass through any compression headers from upstream
      return ok(data, { ...responseHeaders });
    } catch (error) {
      const errorTime = Date.now();
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message} - elapsed: ${errorTime - methodStartTime}ms`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO global sheet data endpoint
  const getLlmoGlobalSheetData = async (context) => {
    const { log } = context;
    const { siteId, configName } = context.params;
    try {
      log.info(`validating LLMO global sheet data for siteId: ${siteId}, configName: ${configName}`);
      // Validate LLMO access but don't use the site-specific dataFolder
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      // Use 'llmo-global' folder
      const sheetURL = `llmo-global/${configName}.json`;

      // Add limit, offset and sheet query params to the url
      const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);
      const { limit, offset, sheet } = context.data;
      if (limit) {
        url.searchParams.set('limit', limit);
      }
      if (offset) {
        url.searchParams.set('offset', offset);
      }
      // allow fetching a specific sheet from the sheet data source
      if (sheet) {
        url.searchParams.set('sheet', sheet);
      }

      // Fetch data from the external endpoint using the global llmo-global folder
      const result = await fetchLlmoSource(context, url.toString());
      if (result.noData) {
        logNotProvisioned(log, siteId, 'llmo-global');
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      log.info(`Successfully proxied global data for siteId: ${siteId}, sheetURL: ${sheetURL}`);
      return cachedOk(result.data, { ...result.headers });
    } catch (error) {
      log.error(`Error proxying global data for siteId: ${siteId}, error: ${error.message}`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO config endpoint
  const getLlmoConfig = async (context) => {
    const { log, s3 } = context;
    const { siteId } = context.params;
    const version = context.data?.version;
    try {
      // Validate site and LLMO access
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      if (!s3 || !s3.s3Client) {
        return badRequest('LLMO config storage is not configured for this environment');
      }

      log.debug(`Fetching LLMO config from S3 for siteId: ${siteId}${version != null ? ` with version: ${version}` : ''}`);
      const { config, exists, version: configVersion } = await readConfig(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
        version,
      });

      // If a specific version was requested but doesn't exist, return 404
      if (version != null && !exists) {
        return notFound(`LLMO config version '${version}' not found for site '${siteId}'`);
      }

      return ok({ config, version: configVersion || null }, {
        'Content-Encoding': 'br',
      });
    } catch (error) {
      log.error(`Error getting llmo config for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  async function updateLlmoConfig(context) {
    const {
      log,
      s3,
      pathInfo,
    } = context;
    const { siteId } = context.params;

    const userId = context.attributes?.authInfo?.getProfile()?.sub || 'system';

    try {
      // hasAccess() must precede isLLMOAdministrator() for delegation-aware checks
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can update the LLMO config');
      }

      // Support gzip-compressed request bodies (Content-Type: application/gzip)
      let { data } = context;
      const contentType = context.request?.headers?.get?.('content-type');
      if (contentType === 'application/gzip') {
        const compressed = Buffer.from(await context.request.arrayBuffer());
        data = JSON.parse(gunzipSync(compressed).toString());
      }

      if (!isObject(data)) {
        return badRequest('LLMO config update must be provided as an object');
      }

      if (!s3 || !s3.s3Client) {
        return badRequest('LLMO config storage is not configured for this environment');
      }

      const prevConfig = await readConfig(siteId, s3.s3Client, { s3Bucket: s3.s3Bucket });

      const { newConfig, stats } = updateModifiedByDetails(
        data,
        prevConfig?.exists ? prevConfig.config : null,
        userId,
      );

      // Validate the config, return 400 if validation fails
      const result = llmoConfigSchema.safeParse(newConfig);
      if (!result.success) {
        const { issues, message } = result.error;
        return createResponse({
          message: `Invalid LLMO config: ${message}`,
          details: issues,
        }, 400);
      }
      const parsedConfig = result.data;

      const { version } = await writeConfig(
        siteId,
        parsedConfig,
        s3.s3Client,
        { s3Bucket: s3.s3Bucket },
      );

      // Only send audit job message if X-Trigger-Audits header is present
      if (pathInfo?.headers?.['x-trigger-audits']) {
        await context.sqs.sendMessage(context.env.AUDIT_JOBS_QUEUE_URL, {
          type: 'llmo-customer-analysis',
          siteId,
          auditContext: {
            configVersion: version,
            previousConfigVersion: prevConfig.exists
              ? prevConfig.version
              : /* c8 ignore next */ null,
          },
        });
      }

      // Build config summary
      const summaryParts = [
        `${stats.prompts.total} prompts${stats.prompts.modified ? ` (${stats.prompts.modified} modified)` : ''}`,
        `${stats.categories.total} categories${stats.categories.modified ? ` (${stats.categories.modified} modified)` : ''}`,
        `${stats.topics.total} topics${stats.topics.modified ? ` (${stats.topics.modified} modified)` : ''}`,
        `${stats.brandAliases.total} brand aliases${stats.brandAliases.modified ? ` (${stats.brandAliases.modified} modified)` : ''}`,
        `${stats.competitors.total} competitors${stats.competitors.modified ? ` (${stats.competitors.modified} modified)` : ''}`,
        `${stats.deletedPrompts.total} deleted prompts${stats.deletedPrompts.modified ? ` (${stats.deletedPrompts.modified} modified)` : ''}`,
        `${stats.ignoredPrompts.total} ignored prompts${stats.ignoredPrompts.modified ? ` (${stats.ignoredPrompts.modified} modified)` : ''}`,
        `${stats.categoryUrls.total} category URLs`,
        ...(stats.claims.modified ? ['claims guidance modified'] : []),
      ];
      const configSummary = summaryParts.join(', ');

      log.info(`User ${userId} modifying customer configuration (${configSummary}) for siteId: ${siteId}, version: ${version}`);
      return ok({ version });
    } catch (error) {
      const msg = `${error?.message || /* c8 ignore next */ error}`;
      log.error(`User ${userId} error updating llmo config for siteId: ${siteId}, error: ${msg}`);
      return badRequest(cleanupHeaderValue(msg));
    }
  }

  // Handles requests to the LLMO questions endpoint, returns both human and ai questions
  const getLlmoQuestions = async (context) => {
    const siteValidation = await getSiteAndValidateLlmo(context);
    if (siteValidation.status) {
      return siteValidation;
    }
    const { llmoConfig } = siteValidation;
    return ok(llmoConfig.questions || {});
  };

  // Handles requests to the LLMO questions endpoint, adds a new question
  // the body format is { Human: [question1, question2], AI: [question3, question4] }
  const addLlmoQuestion = async (context) => {
    const { log } = context;
    const siteValidation = await getSiteAndValidateLlmo(context);
    if (siteValidation.status) {
      return siteValidation;
    }

    if (!accessControlUtil.isLLMOAdministrator()) {
      return forbidden('Only LLMO administrators can add questions');
    }
    const { site, config } = siteValidation;

    // add the question to the llmoConfig
    const newQuestions = context.data;
    if (!newQuestions) {
      return badRequest('No questions provided in the request body');
    }
    let updated = false;

    // Prepare human questions with unique keys
    if (newQuestions.Human && newQuestions.Human.length > 0) {
      const humanQuestionsWithKeys = newQuestions.Human.map((question) => ({
        ...question,
        key: crypto.randomUUID(),
      }));
      config.addLlmoHumanQuestions(humanQuestionsWithKeys);
      updated = true;
    }

    // Prepare AI questions with unique keys
    if (newQuestions.AI && newQuestions.AI.length > 0) {
      const aiQuestionsWithKeys = newQuestions.AI.map((question) => ({
        ...question,
        key: crypto.randomUUID(),
      }));
      config.addLlmoAIQuestions(aiQuestionsWithKeys);
      updated = true;
    }

    if (updated) {
      await saveSiteConfig(site, config, log, 'adding new questions');
    }

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to the LLMO questions endpoint, removes a question
  const removeLlmoQuestion = async (context) => {
    const { log } = context;
    const { questionKey } = context.params;
    const siteValidation = await getSiteAndValidateLlmo(context);
    if (siteValidation.status) {
      return siteValidation;
    }

    if (!accessControlUtil.isLLMOAdministrator()) {
      return forbidden('Only LLMO administrators can remove questions');
    }
    const { site, config } = siteValidation;

    validateQuestionKey(config, questionKey);

    // remove the question using the config method
    config.removeLlmoQuestion(questionKey);

    await saveSiteConfig(site, config, log, 'removing question');

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to the LLMO questions endpoint, updates a question
  const patchLlmoQuestion = async (context) => {
    const { log } = context;
    const { questionKey } = context.params;
    const { data } = context;
    const siteValidation = await getSiteAndValidateLlmo(context);
    if (siteValidation.status) {
      return siteValidation;
    }

    if (!accessControlUtil.isLLMOAdministrator()) {
      return forbidden('Only LLMO administrators can update questions');
    }
    const { site, config } = siteValidation;

    validateQuestionKey(config, questionKey);

    // update the question using the config method
    config.updateLlmoQuestion(questionKey, data);

    await saveSiteConfig(site, config, log, 'updating question');

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to the LLMO customer intent endpoint, returns customer intent array
  const getLlmoCustomerIntent = async (context) => {
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { llmoConfig } = siteValidation;
      return ok(llmoConfig.customerIntent || []);
    } catch (error) {
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO customer intent endpoint, adds new customer intent items
  const addLlmoCustomerIntent = async (context) => {
    const { log } = context;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can add customer intent');
      }
      const { site, config } = siteValidation;

      const newCustomerIntent = context.data;
      if (!Array.isArray(newCustomerIntent)) {
        return badRequest('Customer intent must be provided as an array');
      }

      // Get existing customer intent keys to check for duplicates
      const existingCustomerIntent = config.getLlmoCustomerIntent() || [];
      const existingKeys = new Set(existingCustomerIntent.map((item) => item.key));
      const newKeys = new Set();

      // Validate structure of each customer intent item and check for duplicates
      for (const intent of newCustomerIntent) {
        if (!hasText(intent.key) || !hasText(intent.value)) {
          return badRequest('Each customer intent item must have both key and value properties');
        }

        if (existingKeys.has(intent.key)) {
          return badRequest(`Customer intent key '${intent.key}' already exists`);
        }

        if (newKeys.has(intent.key)) {
          return badRequest(`Duplicate customer intent key '${intent.key}' in request`);
        }

        newKeys.add(intent.key);
      }

      config.addLlmoCustomerIntent(newCustomerIntent);
      await saveSiteConfig(site, config, log, 'adding customer intent');

      // return the updated llmoConfig customer intent
      return ok(config.getLlmoConfig().customerIntent || []);
    } catch (error) {
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO customer intent endpoint, removes a customer intent item
  const removeLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;

      validateCustomerIntentKey(config, intentKey);

      // remove the customer intent using the config method
      config.removeLlmoCustomerIntent(intentKey);

      await saveSiteConfig(site, config, log, 'removing customer intent');

      // return the updated llmoConfig customer intent
      return ok(config.getLlmoConfig().customerIntent || []);
    } catch (error) {
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO customer intent endpoint, updates a customer intent item
  const patchLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;
    const { data } = context;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;

      validateCustomerIntentKey(config, intentKey);

      // Validate the update data
      if (!isObject(data)) {
        return badRequest('Update data must be provided as an object');
      }

      if (!hasText(data.value)) {
        return badRequest('Customer intent value must be a non-empty string');
      }

      // update the customer intent using the config method
      config.updateLlmoCustomerIntent(intentKey, data);

      await saveSiteConfig(site, config, log, 'updating customer intent');

      // return the updated llmoConfig customer intent
      return ok(config.getLlmoConfig().customerIntent || []);
    } catch (error) {
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO CDN logs filter endpoint, updates CDN logs filter configuration
  const patchLlmoCdnLogsFilter = async (context) => {
    const { log } = context;
    const { data } = context;
    const { siteId } = context.params;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can update the CDN logs filter');
      }

      if (!isObject(data)) {
        return badRequest('Update data must be provided as an object');
      }

      const { cdnlogsFilter } = data;

      config.updateLlmoCdnlogsFilter(cdnlogsFilter);

      await saveSiteConfig(site, config, log, 'updating CDN logs filter');

      return ok(config.getLlmoConfig().cdnlogsFilter || []);
    } catch (error) {
      log.error(`Error updating CDN logs filter for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO CDN bucket config endpoint, updates CDN bucket configuration
  const patchLlmoCdnBucketConfig = async (context) => {
    const { log } = context;
    const { data } = context;
    const { siteId } = context.params;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can update the CDN bucket config');
      }

      if (!isObject(data)) {
        return badRequest('Update data must be provided as an object');
      }

      const { cdnBucketConfig } = data;

      config.updateLlmoCdnBucketConfig(cdnBucketConfig);

      await saveSiteConfig(site, config, log, 'updating CDN logs bucket config');

      return ok(config.getLlmoConfig().cdnBucketConfig || {});
    } catch (error) {
      log.error(`Error updating CDN bucket config for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * Onboards a new customer to LLMO.
   * This endpoint handles the complete onboarding process for net new customers
   * including organization validation, site creation, and LLMO configuration.
   * Requires LLMO administrator access.
   *
   * The IMS org ID is resolved in the following order of precedence:
   * 1. `imsOrgId` field in the request payload — must match `/^[a-z0-9]{24}@AdobeOrg$/i`.
   *    Useful when an LLMO administrator is onboarding on behalf of another org.
   * 2. JWT token fallback — derived from `profile.tenants[0].id` appended with
   *    `@AdobeOrg`. This is the original behaviour and is preserved for backward
   *    compatibility with all existing callers that do not supply `imsOrgId`.
   *
   * @param {object} context - The request context.
   * @param {object} context.data - Request payload.
   * @param {string} context.data.domain - Customer domain to onboard.
   * @param {string} context.data.brandName - Brand name for the customer.
   * @param {string} [context.data.imsOrgId] - Optional IMS org ID override
   *   (must match `/^[a-z0-9]{24}@AdobeOrg$/i`). When omitted the org ID
   *   is read from the authenticated user's JWT token.
   * @param {boolean} [context.data['temp-onboarding']] - When true, skips updating
   *   helix-query.yaml in project-elmo-ui-data during onboarding.
   * @returns {Promise<Response>} The onboarding response.
   */
  const onboardCustomer = async (context) => {
    const { log, env, attributes } = context;
    const { data } = context;

    try {
      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can onboard');
      }

      // Validate required fields
      if (!data || typeof data !== 'object') {
        return badRequest('Onboarding data is required');
      }

      const {
        domain, brandName, imsOrgId: payloadImsOrgId, cadence, region,
      } = data;
      const tempOnboarding = data['temp-onboarding'] === true;

      if (!domain || !brandName) {
        return badRequest('domain and brandName are required');
      }

      if (cadence && !VALID_CADENCES.includes(cadence)) {
        return badRequest(`Invalid cadence. Must be one of: ${VALID_CADENCES.join(', ')}`);
      }

      // LLMO-4683: optional ISO 3166-1 alpha-2 region for V1 prompt generation.
      // Forwarded to DRS so the GPT prompt-gen job conditions on the brand's market.
      // Omitted → DRS client default ('US') applies, preserving prior behavior.
      if (region !== undefined && !/^[A-Z]{2}$/.test(region)) {
        return badRequest('Invalid region. Must be an ISO 3166-1 alpha-2 country code (e.g. US, IN, BR)');
      }

      let imsOrgId;

      if (payloadImsOrgId) {
        // Payload takes precedence — validate format before use
        if (!IMS_ORG_ID_REGEX.test(payloadImsOrgId)) {
          log.warn(`LLMO onboarding rejected invalid imsOrgId for domain ${domain}, brand ${brandName}`);
          return badRequest('Invalid imsOrgId');
        }
        log.info(`LLMO onboarding using payload-supplied imsOrgId for domain ${domain}, brand ${brandName}`);
        imsOrgId = payloadImsOrgId;
      } else {
        // Backward-compatible fallback: derive org ID from the JWT token
        const { authInfo } = attributes;

        if (!authInfo) {
          return badRequest('Authentication information is required');
        }

        const profile = authInfo.getProfile();

        if (!profile || !profile.tenants?.[0]?.id) {
          const message = 'User profile or organization ID not found in authentication token';
          log.warn(`LLMO onboarding validation failed for domain ${domain}, brand ${brandName}. Validation Error: ${message}`);
          return badRequest(message);
        }

        imsOrgId = `${profile.tenants[0].id}@AdobeOrg`;
      }

      // Construct base URL and data folder name
      const baseURL = composeBaseURL(domain);
      const dataFolder = generateDataFolder(baseURL, env.ENV);

      log.info(`Starting LLMO onboarding for IMS org ${imsOrgId}, domain ${domain}, brand ${brandName}`);

      // Validate that the site has not been onboarded yet
      const validation = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);
      if (!validation.isValid) {
        log.warn(`LLMO onboarding validation failed for IMS org ${imsOrgId}, domain ${domain}, brand ${brandName}. Validation Error: ${validation.error}`);
        return badRequest(validation.error);
      }

      // Perform the complete onboarding process
      const result = await performLlmoOnboarding(
        {
          domain,
          brandName,
          imsOrgId,
          cadence,
          tempOnboarding,
          ...(region ? { region } : {}),
        },
        context,
      );

      let brandProfileExecutionName = null;
      try {
        const site = await context.dataAccess?.Site?.findById(result.siteId);
        if (site) {
          brandProfileExecutionName = await triggerBrandProfileAgent({
            context,
            site,
            reason: 'llmo-http',
          });
        }
      } catch (hookError) {
        log.warn(`LLMO onboarding: failed to trigger brand-profile workflow for site ${result.siteId}`, hookError);
      }

      log.info(`LLMO onboarding completed successfully for domain ${domain}`);

      return ok({
        message: result.message,
        domain,
        brandName,
        imsOrgId,
        baseURL: result.baseURL,
        dataFolder: result.dataFolder,
        organizationId: result.organizationId,
        siteId: result.siteId,
        detectedCdn: result.detectedCdn,
        status: 'completed',
        createdAt: new Date().toISOString(),
        brandProfileExecutionName,
        ...(region ? { region } : {}),
      });
    } catch (error) {
      log.error(`Error during LLMO onboarding: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * Paid-gated self-serve, site-only onboarding (LLMO-5606, Piece 1 of LLMO-3749).
   *
   * Stands up the site entity, entitlement/enrollment, base LLMO config, and
   * site-analysis audits — "nothing DRS": no brand entity, no prompt generation,
   * no brand-presence schedule, no llmo-customer-analysis. Reuses the canonical
   * `performLlmoOnboarding` via the `siteOnly` flag. Activating a brand +
   * generating prompts is Piece 2 (LLMO-5605).
   *
   * Org-scoped (`/v2/orgs/:spaceCatId/...`). Gated on org membership + an explicit
   * PAID LLMO entitlement (no admin claim — this is customer self-serve, mirroring
   * the v2 brand-management routes). Customers never see
   * the internal failure reason — both failures and successes are posted to ops in
   * SLACK_LLMO_ALERTS_CHANNEL_ID. Runs synchronously; `status: 'processing'` is
   * honest because the triggered audits run asynchronously.
   *
   * @param {object} context - The request context.
   * @param {string} context.params.spaceCatId - SpaceCat organization ID (UUID).
   * @param {string} context.data.domain - Domain to onboard (normalized via composeBaseURL).
   * @param {string} context.data.brandName - Brand label (siteConfig LLMO brand, not an entity).
   * @param {string} [context.data.deliveryType] - Optional delivery type for site creation.
   * @returns {Promise<Response>} 201 with site details, or 400/403/404 on failure.
   */
  const onboardSiteOnly = async (context) => {
    const { log, env, dataAccess } = context;
    const { Organization } = dataAccess;
    const { spaceCatId } = context.params;
    const { data } = context;

    // Customers never see the internal reason — only a generic failure.
    const GENERIC_ONBOARD_ERROR = "We couldn't onboard this domain — please contact support.";

    try {
      // --- Resolve org (404 if missing) ---
      const organization = await Organization.findById(spaceCatId);
      if (!organization) {
        return notFound('Organization not found');
      }

      // --- Auth gate: org membership + explicit PAID entitlement ---
      // Mirrors the v2 brand-management routes (brands.js), which gate on
      // hasAccess(organization) alone. This is a paid-customer self-serve
      // endpoint, so it deliberately does NOT require a platform-admin /
      // LLMO-admin claim: those are never set on a real customer IMS token
      // (the IMS handler grants the admin scope only for @adobe.com platform
      // admins), so requiring them would 403 every paying customer. The
      // explicit PAID check below is the additional, stricter gate.
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only members of the organization can onboard a site');
      }

      // Explicit PAID check. PAID is stricter than the platform's any-tier
      // "LLMO-enabled" bar, so a FREE_TRIAL org 403s here. There is no status
      // column on entitlements (getStatus() is an unbacked stub; revocation =
      // row delete), so a PAID row existing is the "currently paying" signal.
      const tierClient = TierClient.createForOrg(
        context,
        organization,
        EntitlementModel.PRODUCT_CODES.LLMO,
      );
      const { entitlement } = await tierClient.checkValidEntitlement();
      if (!entitlement || entitlement.getTier() !== EntitlementModel.TIERS.PAID) {
        return forbidden('A paid LLMO entitlement is required to onboard a site');
      }

      // --- Validate request body ---
      if (!data || typeof data !== 'object') {
        return badRequest('Onboarding data is required');
      }
      const { domain, brandName, deliveryType } = data;
      if (!hasText(domain) || !hasText(brandName)) {
        return badRequest('domain and brandName are required and must be non-empty strings');
      }
      // Customer-facing endpoint — bound the inputs. RFC 1035 caps a hostname at
      // 253 chars; brandName is a label, so cap it defensively too.
      if (domain.trim().length > 253) {
        return badRequest('domain is too long');
      }
      if (brandName.trim().length > 256) {
        return badRequest('brandName is too long');
      }

      const baseURL = composeBaseURL(domain.trim());
      if (!isValidUrl(baseURL)) {
        return badRequest('domain is invalid');
      }

      // SSRF guard: onboarding triggers outbound probes against this host (CDN
      // detection, Ahrefs), so reject anything that isn't a public registrable
      // domain — IP literals (including the 169.254.169.254 metadata address),
      // localhost, and single-label/internal hosts all fail here. (Resolve-time
      // private-IP-range checks are a deeper, cross-cutting follow-up.)
      const { isIp, domain: registrableDomain } = parseDomain(new URL(baseURL).hostname);
      if (isIp || !registrableDomain) {
        log.warn(`Site-only onboarding rejected non-public host for org ${spaceCatId}, domain ${domain}`);
        return badRequest('domain is invalid');
      }

      const dataFolder = generateDataFolder(baseURL, env.ENV);
      const imsOrgId = organization.getImsOrgId();

      log.info(`Starting site-only LLMO onboarding for org ${spaceCatId} (IMS ${imsOrgId}), domain ${domain}`);

      // validateSiteNotOnboarded returns { isValid, error } (never throws) and
      // already ops-alerts the conflict cases. Surface only a generic 400.
      const validation = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);
      if (!validation.isValid) {
        log.warn(`Site-only onboarding rejected for org ${spaceCatId}, domain ${domain}: ${validation.error}`);
        return badRequest(GENERIC_ONBOARD_ERROR);
      }

      // --- Orchestrate (siteOnly: true; no `say` → zero customer Slack) ---
      const result = await performLlmoOnboarding(
        {
          domain,
          brandName,
          imsOrgId,
          deliveryType,
          siteOnly: true,
        },
        context,
      );

      await postLlmoAlert(
        `:white_check_mark: Site-only onboarding succeeded for ${result.baseURL} `
        + `(org ${result.organizationId}, site ${result.siteId})`,
        context,
      );

      log.info(`Site-only LLMO onboarding completed for org ${spaceCatId}, site ${result.siteId}`);

      return created({
        siteId: result.siteId,
        organizationId: result.organizationId,
        baseURL: result.baseURL,
        dataFolder: result.dataFolder,
        status: 'processing',
      });
    } catch (error) {
      log.error(`Error during site-only LLMO onboarding for org ${spaceCatId}: ${error.message}`);
      await postLlmoAlert(
        `:x: Site-only onboarding failed for org ${spaceCatId}: ${error.message}`,
        context,
      );
      return internalServerError(GENERIC_ONBOARD_ERROR);
    }
  };

  /**
   * Offboards a customer from LLMO.
   * This endpoint handles the complete offboarding process including
   * disabling audits and cleaning up LLMO configuration.
   * @param {object} context - The request context.
   * @returns {Promise<Response>} The offboarding response.
   */
  const offboardCustomer = async (context) => {
    const { log } = context;
    const { siteId } = context.params;

    try {
      log.info(`Starting LLMO offboarding for site ${siteId}`);

      // Validate site and LLMO access
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;

      // Perform the complete offboarding process
      const result = await performLlmoOffboarding(site, config, context);

      log.info(`LLMO offboarding completed successfully for site ${siteId}`);

      return ok({
        message: result.message,
        siteId: result.siteId,
        baseURL: result.baseURL,
        dataFolder: result.dataFolder,
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error(`Error during LLMO offboarding for site ${siteId}: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  const queryFiles = async (context) => {
    const { log } = context;
    const { siteId, sheetType } = context.params;
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const sheetDataAccessBlocked = isHlxSheetDataAccessBlocked(context);
      if (sheetDataAccessBlocked && sheetType) {
        return forbidden(HLX_SHEET_DATA_PG_MIGRATION_FORBIDDEN_MESSAGE);
      }
      const { llmoConfig } = siteValidation;
      const queryResult = await queryLlmoFiles(context, llmoConfig);
      if (queryResult.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      return cachedOk(queryResult.data, queryResult.headers);
    } catch (error) {
      log.error(`Error during LLMO cached query for site ${siteId}: ${error.message}`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Updates a single row in an LLMO XLSX data sheet stored in SharePoint.
  // Round-trips the workbook (read → modify → upload → publish), so this is
  // intended for low-frequency UI edits (e.g. soft-delete on Strategic Recommendations).
  const patchLlmoDataRow = async (context) => {
    const { log, env } = context;
    const { siteId, sheetType, dataSource } = context.params;
    const { data } = context;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { llmoConfig } = siteValidation;

      if (!hasText(dataSource)) {
        return badRequest('dataSource path parameter is required');
      }
      // Reject path-traversal attempts before concatenating into SharePoint or admin.hlx.page URLs.
      if (!isSafePathSegment(dataSource)) {
        return badRequest('dataSource must contain only alphanumerics, hyphen, and underscore');
      }
      if (sheetType !== undefined && !isSafePathSegment(sheetType)) {
        return badRequest('sheetType must contain only alphanumerics, hyphen, and underscore');
      }

      const parsed = parseSheetRowPatch(data);
      if (parsed.error) {
        return badRequest(parsed.error);
      }
      const { updates, isBatch } = parsed;

      const sharepointPath = sharepointPathFor(llmoConfig.dataFolder, sheetType, dataSource);
      const publishPath = publishPathFor(llmoConfig.dataFolder, sheetType, dataSource);

      log.info(`Patching LLMO sheet rows for site ${siteId} at ${sharepointPath} (${updates.length} update(s))`);
      const { results } = await patchSheetRows(
        { sharepointPath, publishPath, updates },
        { env, log },
      );

      // Preserve the single-row response shape for back-compat with callers that
      // posted the single-update body; emit a batch shape for callers using `updates`.
      if (!isBatch) {
        const [single] = results;
        return ok({
          siteId,
          sheetType: sheetType || null,
          dataSource,
          sheet: single.sheet,
          rowNumber: single.rowNumber,
          updated: single.updated,
        });
      }
      return ok({
        siteId,
        sheetType: sheetType || null,
        dataSource,
        updates: results,
      });
    } catch (error) {
      log.error(`Error patching LLMO sheet row for site ${siteId}: ${error.message}`);
      const status = error.statusCode;
      if (status === 404) {
        return notFound(cleanupHeaderValue(error.message));
      }
      if (status === 409) {
        return createResponse(
          { message: cleanupHeaderValue(error.message) },
          409,
        );
      }
      if (status === 400) {
        return badRequest(cleanupHeaderValue(error.message));
      }
      // Unexpected errors (SDK failures, missing env, network) — full detail goes to
      // the logs above; respond with a generic message so internals are not leaked.
      return internalServerError('Failed to patch sheet row');
    }
  };

  // Handles requests to the LLMO rationale endpoint
  const getLlmoRationale = async (context) => {
    const { log } = context;
    const { siteId } = context.params;
    try {
      // Validate site and LLMO access
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      // Delegate to the rationale handler for the actual processing
      return await handleLlmoRationale(context);
    } catch (error) {
      log.error(`Error getting LLMO rationale for site ${siteId}: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the brand claims endpoint
  const getBrandClaims = async (context) => {
    const { log } = context;
    const { siteId } = context.params;
    try {
      // Validate site and LLMO access
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      // Delegate to the brand claims handler for the actual processing
      return await handleBrandClaims(context);
    } catch (error) {
      log.error(`Error getting brand claims for site ${siteId}: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Factory for demo fixture endpoints — validates site/LLMO access then delegates to handler
  const createDemoFixtureHandler = (handler, label) => async (context) => {
    const { log } = context;
    const { siteId } = context.params;
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }

      return await handler(context);
    } catch (error) {
      log.error(`Unexpected error retrieving demo ${label} for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to retrieve demo fixture');
    }
  };

  const getDemoBrandPresence = createDemoFixtureHandler(handleDemoBrandPresence, 'brand-presence');
  const getDemoRecommendations = createDemoFixtureHandler(handleDemoRecommendations, 'recommendations');

  /**
   * POST /sites/{siteId}/llmo/edge-optimize-config
   * Creates or updates Tokowaka edge optimization configuration
   * - Updates site's tokowaka meta-config in S3
   * - Updates site's tokowakaEnabled in site config
   * - Optional `cdnType`: if CDN type is supported - does CDN routing
   * @param {object} context - Request context
   * @returns {Promise<Response>} Created/updated edge config
   */
  const createOrUpdateEdgeConfig = async (context) => {
    const {
      log, dataAccess, env, s3,
    } = context;
    const { siteId } = context.params;
    const { authInfo: { profile } } = context.attributes;
    const { Site } = dataAccess;
    const {
      enhancements, tokowakaEnabled, forceFail, patches = {}, prerender, cdnType, enabled,
    } = context.data || {};

    log.info(`createOrUpdateEdgeConfig request received for site ${siteId}, data=${JSON.stringify(context.data)}`);

    if (tokowakaEnabled !== undefined && typeof tokowakaEnabled !== 'boolean') {
      return badRequest('tokowakaEnabled field must be a boolean');
    }

    if (enhancements !== undefined && typeof enhancements !== 'boolean') {
      return badRequest('enhancements field must be a boolean');
    }

    if (forceFail !== undefined && typeof forceFail !== 'boolean') {
      return badRequest('forceFail field must be a boolean');
    }

    if (patches !== undefined && typeof patches !== 'object') {
      return badRequest('patches field must be an object');
    }

    if (prerender !== undefined && (typeof prerender !== 'object' || Array.isArray(prerender) || !Array.isArray(prerender.allowList))) {
      return badRequest('prerender field must be an object with allowList property that is an array');
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return badRequest('enabled field must be a boolean');
    }

    try {
      // Get site
      const site = await Site.findById(siteId);

      if (!site) {
        return notFound('Site not found');
      }

      // No productCode is passed to hasAccess(); the delegation block is not entered.
      // Org membership is the intended access gate for this endpoint.
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can update the edge optimize config');
      }

      if (!await accessControlUtil.isOwnerOfSite(site)) {
        return forbidden('User does not own this site');
      }

      const baseURL = site.getBaseURL();
      const tokowakaClient = TokowakaClient.createFrom(context);

      // Handle S3 metaconfig
      let metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
      const lastModifiedBy = profile?.email || 'tokowaka-edge-optimize-config';

      if (!metaconfig || !Array.isArray(metaconfig.apiKeys) || metaconfig.apiKeys.length === 0) {
        // Create new metaconfig with generated API key
        metaconfig = await tokowakaClient.createMetaconfig(
          baseURL,
          site.getId(),
          {
            ...(tokowakaEnabled !== undefined && { tokowakaEnabled }),
            ...(enhancements !== undefined && { enhancements }),
          },
          {
            lastModifiedBy,
          },
        );
      } else {
        metaconfig = await tokowakaClient.updateMetaconfig(
          baseURL,
          site.getId(),
          {
            tokowakaEnabled,
            enhancements,
            patches,
            forceFail,
            prerender,
          },
          {
            lastModifiedBy,
          },
        );
      }

      const currentConfig = site.getConfig();
      const existingEdgeConfig = currentConfig.getEdgeOptimizeConfig() || {};
      const isNewlyOpted = !existingEdgeConfig.opted;

      // Kick off IMS + S3 in parallel with saveSiteConfig — all three are independent
      let notificationPrep = null;
      if (isNewlyOpted) {
        const imsUserId = profile?.email;

        const imsPromise = imsUserId && context.imsClient
          ? Promise.resolve(context.imsClient.getImsAdminProfile(imsUserId))
          : Promise.resolve(null);

        const s3Promise = s3?.s3Client
          ? Promise.resolve(readConfig(siteId, s3.s3Client, { s3Bucket: s3.s3Bucket }))
          : Promise.resolve(null);

        notificationPrep = Promise.allSettled([imsPromise, s3Promise]);
      }

      currentConfig.updateEdgeOptimizeConfig({
        ...existingEdgeConfig,
        opted: existingEdgeConfig.opted ?? Date.now(),
      });
      await saveSiteConfig(site, currentConfig, log, 'updating edge optimize config');
      log.info(`[edge-optimize-config] Updated edge optimize config for site ${siteId} by ${lastModifiedBy}`);

      // Send Slack notification only when opted field is being added
      if (isNewlyOpted) {
        try {
          const llmoTeamUserIds = env.SLACK_LLMO_EDGE_OPTIMIZE_TEAM;

          // Build user mentions from comma-separated user IDs
          let userMentions = '';
          if (hasText(llmoTeamUserIds)) {
            const userIds = llmoTeamUserIds.split(',').map((id) => id.trim()).filter((id) => id);
            userMentions = userIds.map((userId) => `<@${userId}>`).join(' ');
          }

          const message = `:gear: Site has opted for edge optimization\n\n• Site: ${baseURL}${userMentions ? `\n\ncc: ${userMentions}` : ''}`;

          await postLlmoAlert(message, context);
          log.info(`[edge-optimize-config] Slack notification sent for site ${siteId}`);
        } catch (slackError) {
          // Log error but don't fail the request
          log.error(`[edge-optimize-config] Failed to send Slack notification for site ${siteId}:`, slackError);
        }

        try {
          const [adminProfile, llmoCfgResult] = await notificationPrep;
          let notificationCdnType;
          if (llmoCfgResult.status === 'fulfilled') {
            notificationCdnType = llmoCfgResult.value?.config?.cdnBucketConfig?.cdnProvider;
          } else {
            log.warn(`[cdn-opt-in-notification] Could not read S3 LLMO config for cdnProvider lookup (site=${siteId}): ${llmoCfgResult.reason?.message}`);
          }
          if (!hasText(notificationCdnType) && hasText(cdnType)) {
            notificationCdnType = cdnType;
          }

          if (notificationCdnType === CDN_TYPES.AEM_CS_FASTLY) {
            log.info(`[cdn-opt-in-notification] Email skipped for site=${siteId} reason=aem-cs-fastly`);
          } else {
            let optedBy;
            if (adminProfile.status === 'fulfilled') {
              optedBy = adminProfile.value?.email;
            } else {
              log.warn(`[cdn-opt-in-notification] Could not resolve user email from IMS: ${adminProfile.reason?.message}`);
            }

            await notifyOptInIfNeeded(context, {
              siteId,
              siteBaseURL: baseURL,
              cdnType: notificationCdnType,
              orgId: site.getOrganizationId?.(),
              optedBy,
            });
          }
        } catch (err) {
          log.error('[cdn-opt-in-notification] Unhandled error:', err);
        }
      }

      let cdnTypeNormalized = null;
      if (hasText(cdnType)) {
        log.info(`[edge-optimize-routing] ${baseURL} CDN routing config requested for site ${siteId},`
          + ` cdnType: ${cdnType}, enabled: ${enabled}`);
        const cdnTypeTrimmed = cdnType.toLowerCase().trim();
        cdnTypeNormalized = SUPPORTED_EDGE_ROUTING_CDN_TYPES.includes(cdnTypeTrimmed)
          ? cdnTypeTrimmed : null;
        if (!cdnTypeNormalized) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} cdnType: ${cdnType} not eligible for automated routing`);
        } else {
          // Verify the requested CDN type matches the domain's actual CDN via DNS
          try {
            // overwrite base url
            const overrideBaseURL = site.getConfig()?.getFetchConfig?.()?.overrideBaseURL;
            const effectiveBaseUrl = isValidUrl(overrideBaseURL) ? overrideBaseURL : baseURL;
            const hostname = calculateForwardedHost(effectiveBaseUrl, log);
            const detectedCdn = await detectAemCsFastlyForDomain(hostname, log);
            if (!detectedCdn || detectedCdn !== cdnTypeNormalized) {
              log.error(`[edge-optimize-routing-failed] ${baseURL} Requested cdnType: '${cdnTypeNormalized}', detected CDN: '${detectedCdn}'`);
              return badRequest(`Requested CDN type '${cdnTypeNormalized}' does not match the detected CDN for this domain`);
            }
          } catch (detectError) {
            log.error(`[edge-optimize-routing-failed] ${baseURL} CDN auto-detection failed: ${detectError.message}`);
          }
        }
      }
      // CDN routing — only when cdnType is provided
      if (cdnTypeNormalized) {
        // Exchange promise token from cookie for an IMS user token
        let imsUserToken;
        try {
          imsUserToken = await getImsTokenFromPromiseToken(context);
          log.info(`[edge-optimize-routing] IMS user token obtained for site ${siteId}`);
        } catch (tokenError) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} Failed to get IMS user token: ${tokenError.message}`);
          return createResponse({ message: tokenError.message }, tokenError.status ?? 401);
        }

        // Authorization: paid (LLMO product context) or trial (LLMO Admin IMS group)
        const org = await site.getOrganization();
        const imsOrgId = org.getImsOrgId();
        try {
          await authorizeEdgeCdnRouting(
            context,
            {
              org,
              imsOrgId,
              imsUserToken,
              siteId,
            },
            log,
          );
        } catch (authErr) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} Failed to authorize CDN routing: ${authErr.message}`);
          return createResponse({ message: authErr.message }, authErr.status ?? 403);
        }

        // Restrict to production environment
        if (env?.ENV && env.ENV !== 'prod') {
          log.error(`[edge-optimize-routing-failed] ${baseURL} CDN routing is not available in ${env.ENV} environment`);
          return createResponse({ message: `CDN routing is not available in ${env.ENV} environment` }, 400);
        }

        let cdnConfig;
        try {
          cdnConfig = parseEdgeRoutingConfig(env?.EDGE_OPTIMIZE_ROUTING_CONFIG, cdnTypeNormalized);
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            log.error(`[edge-optimize-routing-failed] ${baseURL} EDGE_OPTIMIZE_ROUTING_CONFIG invalid JSON: ${parseError.message}`);
            return internalServerError('Failed to parse routing config.');
          }
          log.error(`[edge-optimize-routing-failed] ${baseURL} ${parseError.message}`);
          return createResponse({ message: 'API is missing mandatory environment variable' }, 503);
        }

        const strategy = EDGE_OPTIMIZE_CDN_STRATEGIES[cdnTypeNormalized];
        const routingEnabled = enabled ?? true;

        // Probe the live site to resolve the canonical domain for the CDN API call
        const overrideBaseURL = site.getConfig()?.getFetchConfig?.()?.overrideBaseURL;
        const effectiveBaseUrl = isValidUrl(overrideBaseURL) ? overrideBaseURL : baseURL;
        const probeUrl = effectiveBaseUrl.startsWith('http') ? effectiveBaseUrl : `https://${effectiveBaseUrl}`;
        log.info(`[edge-optimize-routing] Probing site ${probeUrl}`);
        let domain;
        try {
          domain = await probeSiteAndResolveDomain(probeUrl, log);
        } catch (probeError) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} CDN routing probe failed: ${probeError.message}`);
          return badRequest(probeError.message);
        }

        // Obtain org-scoped SP token for the CDN API call
        let spToken;
        try {
          const imsEdgeClient = new ImsClient({
            imsHost: env.IMS_HOST,
            clientId: env.IMS_EDGE_CLIENT_ID,
            clientSecret: env.IMS_EDGE_CLIENT_SECRET,
            scope: env.IMS_EDGE_SCOPE,
          }, log);
          const spTokenData = await imsEdgeClient.getServicePrincipalAccessToken(imsOrgId);
          spToken = spTokenData.access_token;
          log.info(`[edge-optimize-routing] Service Principal token obtained for site ${siteId}`);
        } catch (tokenError) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} Failed to obtain SP token: ${tokenError.message}`);
          return unauthorized('Authentication failed with upstream IMS service');
        }

        // Call CDN API with the SP token
        const cdnApiStart = Date.now();
        try {
          await callCdnRoutingApi(strategy, cdnConfig, domain, spToken, routingEnabled, log);
        } catch (cdnError) {
          log.error(`[edge-optimize-routing-failed] ${baseURL} CDN API call failed in ${Date.now() - cdnApiStart}ms: ${cdnError.message}`);
          return internalServerError('Failed to update CDN routing');
        }

        log.info(`[edge-optimize-routing] CDN routing updated for site ${siteId}, domain ${domain} in ${Date.now() - cdnApiStart}ms`);

        if (routingEnabled) {
          // Trigger the import worker job to detect when edge-optimize goes live and stamp
          // edgeOptimizeConfig.enabled. Delayed by 5 minutes to allow CDN propagation.
          try {
            await context.sqs.sendMessage(
              env.IMPORT_WORKER_QUEUE_URL,
              { type: OPTIMIZE_AT_EDGE_ENABLED_MARKING_TYPE },
              undefined,
              { delaySeconds: EDGE_OPTIMIZE_MARKING_DELAY_SECONDS },
            );
            log.info('[edge-optimize-routing] Queued edge-optimize enabled marking for site'
               + ` ${siteId} (delay: ${EDGE_OPTIMIZE_MARKING_DELAY_SECONDS}s)`);
          } catch (sqsError) {
            log.warn(`[edge-optimize-routing-failed] ${baseURL} Failed to queue edge-optimize enabled marking: ${sqsError.message}`);
          }
        } else {
          // Routing disabled — record the disabled state immediately in site config.
          const updatedEdgeConfig = currentConfig.getEdgeOptimizeConfig() || {};
          currentConfig.updateEdgeOptimizeConfig({
            ...updatedEdgeConfig,
            enabled: false,
          });
          await saveSiteConfig(site, currentConfig, log, 'marking edge optimize disabled');
          log.info(`[edge-optimize-routing] Marked edge optimize as disabled for site ${siteId}`);
        }
        log.info(`[edge-optimize-routing] ${baseURL} CDN routing ${routingEnabled ? 'enabled' : 'disabled'} successfully`);
      }

      return ok({
        ...metaconfig,
      });
    } catch (error) {
      log.error(`Failed to create/update edge config for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * GET /sites/{siteId}/llmo/edge-optimize-config
   * Retrieves Tokowaka edge optimization configuration
   * - Fetches S3 metaconfig (opportunities/{domain}/config)
   * - Returns edgeOptimizeConfig from site config
   * @param {object} context - Request context
   * @returns {Promise<Response>} Edge config or not found
   */
  const getEdgeConfig = async (context) => {
    const { log, dataAccess } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;

    try {
      // Get site
      const site = await Site.findById(siteId);

      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can get the edge optimize config');
      }

      const baseURL = site.getBaseURL();

      // Fetch metaconfig from S3
      const tokowakaClient = TokowakaClient.createFrom(context);
      const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);

      return ok({
        ...metaconfig,
      });
    } catch (error) {
      log.error(`Failed to fetch edge config for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * GET /sites/{siteId}/llmo/strategy
   * Retrieves LLMO strategy data from S3
   * @param {object} context - Request context
   * @returns {Promise<Response>} Strategy data and version, or 404 if not found
   */
  const getStrategy = async (context) => {
    const { log, s3 } = context;
    const { siteId } = context.params;
    const version = context.data?.version;

    try {
      if (!s3 || !s3.s3Client) {
        return badRequest('LLMO strategy storage is not configured for this environment');
      }

      log.info(`Fetching LLMO strategy from S3 for siteId: ${siteId}${version != null ? ` with version: ${version}` : ''}`);
      const { data, exists, version: strategyVersion } = await readStrategy(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
        version,
      });

      if (!exists) {
        return notFound(`LLMO strategy not found for site '${siteId}'${version != null ? ` with version '${version}'` : ''}`);
      }

      return ok({ data, version: strategyVersion }, {
        'Content-Encoding': 'br',
      });
    } catch (error) {
      log.error(`Error getting llmo strategy for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * PUT /sites/{siteId}/llmo/strategy
   * Saves LLMO strategy data to S3.
   * Status changes trigger email notifications (when enabled).
   * @param {object} context - Request context
   * @returns {Promise<Response>} Version of the saved strategy
   */
  const saveStrategy = async (context) => {
    const {
      log, s3, data, dataAccess,
    } = context;
    const { siteId } = context.params;

    try {
      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can save the LLMO strategy');
      }

      if (!isObject(data)) {
        return badRequest('LLMO strategy must be provided as an object');
      }

      if (!s3 || !s3.s3Client) {
        return badRequest('LLMO strategy storage is not configured for this environment');
      }

      // Read previous strategy for diff (best-effort, null if not found)
      let prevData = null;
      let skipNotifications = false;
      try {
        const prev = await readStrategy(siteId, s3.s3Client, { s3Bucket: s3.s3Bucket });
        if (prev.exists) {
          prevData = prev.data;
        }
      } catch (readError) {
        skipNotifications = true;
        log.warn(`Could not read previous strategy for site ${siteId} (notifications will be skipped): ${readError.message}`);
      }

      log.info(`Writing LLMO strategy to S3 for siteId: ${siteId}`);
      const { version } = await writeStrategy(siteId, data, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
      });

      log.info(`Successfully saved LLMO strategy for siteId: ${siteId}, version: ${version}`);

      // Await notifications and include summary in response for debugging
      let siteBaseUrl = '';
      if (dataAccess?.Site) {
        const site = await dataAccess.Site.findById(siteId);
        siteBaseUrl = site?.getBaseURL?.() || '';
      }
      let notificationSummary = {
        sent: 0, failed: 0, skipped: 0, changes: 0,
      };
      if (!skipNotifications) {
        try {
          notificationSummary = await notifyStrategyChanges(context, {
            prevData,
            nextData: data,
            siteId,
            siteBaseUrl,
          });
          if (notificationSummary.changes > 0) {
            log.info(`Strategy notification summary for site ${siteId}: ${JSON.stringify(notificationSummary)}`);
          }
        } catch (err) {
          log.error(`Strategy notification error for site ${siteId}: ${err.message}`);
        }
      }

      return ok({ version, notifications: notificationSummary });
    } catch (error) {
      log.error(`Error saving llmo strategy for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  const checkEdgeOptimizeStatus = async (context) => {
    const { log, dataAccess } = context;
    const { Site } = dataAccess;
    const { siteId } = context.params;
    const { path = '/' } = context.data || {};

    // Validate siteId
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    log.info(`Checking Edge Optimize status for siteId: ${siteId} and path: ${path}`);

    // Get site from database
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    // Check access control
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Access denied to this site');
    }

    try {
      const tokowakaClient = TokowakaClient.createFrom(context);
      const result = await tokowakaClient.checkEdgeOptimizeStatus(site, path);
      return ok(result);
    } catch (error) {
      log.error(`Error checking edge optimize status: ${error.message} for site: ${siteId} and path: ${path}`);
      if (error.status) {
        return createResponse({ message: error.message }, error.status);
      }
      return internalServerError(cleanupHeaderValue(error.message));
    }
  };

  const markOpportunitiesReviewed = async (context) => {
    const { log } = context;

    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { site, config } = siteValidation;
      const OPPORTUNITIES_REVIEWED_TAG = 'opportunitiesReviewed';
      const tags = config.getLlmoConfig().tags || [];

      if (tags.includes(OPPORTUNITIES_REVIEWED_TAG)) {
        log.info(`Site ${site.getId()} already has '${OPPORTUNITIES_REVIEWED_TAG}' tag, skipping`);
        return ok(tags);
      }

      const userId = context.attributes?.authInfo?.getProfile()?.sub || 'system';
      config.addLlmoTag(OPPORTUNITIES_REVIEWED_TAG);

      await saveSiteConfig(site, config, log, 'marking opportunities as reviewed');

      log.info(`User ${userId} marked opportunities as reviewed for site ${site.getId()}, added '${OPPORTUNITIES_REVIEWED_TAG}' tag`);

      return ok(config.getLlmoConfig().tags || []);
    } catch (error) {
      log.error(`Error marking opportunities as reviewed: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * Check if all URLs in urlList have the same base domain as prodBaseURL.
   * @param {string[]} urlList the list of URLs/domains to check.
   * @param {string} prodBaseURL the production base URL to match against.
   * @returns {boolean} true if all URLs share the same domain as prodBaseURL
   */
  function areDomainsSameAsBase(urlList, prodBaseURL) {
    const prodDomain = getDomain(prodBaseURL);
    return urlList.every((stageBaseURL) => getDomain(stageBaseURL) === prodDomain);
  }

  /**
   * POST /sites/{siteId}/llmo/edge-optimize-config/stage
   * Adds staging domains for edge optimize (stage environment support).
   * Creates or finds stage sites in Spacecat (same org), creates Tokowaka metaconfig per stage site
   * with prerender for whole domain, and persists stagingDomains on prod site's edgeOptimizeConfig.
   * Returns the complete S3 metaconfig for each stage site in an array.
   * @param {object} context - Request context
   * @returns {Promise<Response>} 200 with stageConfigs array (full S3 metaconfig per stage)
   */
  const createOrUpdateStageEdgeConfig = async (context) => {
    const { log, dataAccess } = context;
    const { siteId } = context.params;
    const { authInfo: { profile } } = context.attributes;
    const { Site } = dataAccess;
    const { stagingDomains: rawStagingDomains } = context.data || {};

    if (!Array.isArray(rawStagingDomains) || rawStagingDomains.length === 0) {
      return badRequest('stagingDomains must be a non-empty array');
    }

    const stagingDomains = rawStagingDomains
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter((d) => hasText(d));
    if (stagingDomains.length === 0) {
      return badRequest('stagingDomains must contain at least one non-empty domain string');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }
      // No productCode is passed to hasAccess(); the delegation block is not entered.
      // Org membership is the intended access gate for this endpoint.
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can add staging domains');
      }

      if (!areDomainsSameAsBase(stagingDomains, site.getBaseURL())) {
        return badRequest('Staging domains must belong to the same base domain as the production site');
      }

      const tokowakaClient = TokowakaClient.createFrom(context);
      const lastModifiedBy = profile?.email || 'tokowaka-stage-edge-optimize-config';
      const organizationId = site.getOrganizationId();
      const newEntries = [];
      const stageConfigs = [];

      /* eslint-disable no-await-in-loop */
      for (const domain of stagingDomains) {
        const stageBaseURL = composeBaseURL(domain);
        let stageSite = await Site.findByBaseURL(stageBaseURL);
        if (!stageSite) {
          stageSite = await Site.create({
            baseURL: stageBaseURL,
            organizationId,
          });
        }

        let metaconfig = await tokowakaClient.fetchMetaconfig(stageBaseURL);
        if (!metaconfig || !Array.isArray(metaconfig?.apiKeys) || metaconfig.apiKeys.length === 0) {
          metaconfig = await tokowakaClient.createMetaconfig(
            stageBaseURL,
            stageSite.getId(),
            {
              tokowakaEnabled: true,
            },
            { lastModifiedBy, isStageDomain: true },
          );
        } else {
          await tokowakaClient.updateMetaconfig(
            stageBaseURL,
            stageSite.getId(),
            {},
            { lastModifiedBy, isStageDomain: true },
          );
          metaconfig = await tokowakaClient.fetchMetaconfig(stageBaseURL);
        }

        newEntries.push({ domain, id: stageSite.getId() });
        stageConfigs.push({
          domain,
          ...metaconfig,
        });
      }
      /* eslint-enable no-await-in-loop */

      const currentConfig = site.getConfig();
      const existingEdgeConfig = currentConfig.getEdgeOptimizeConfig() || {};
      const existingList = existingEdgeConfig.stagingDomains || [];
      const byDomain = new Map(existingList.map((e) => [e.domain, e]));
      for (const entry of newEntries) {
        byDomain.set(entry.domain, { domain: entry.domain, id: entry.id });
      }
      const mergedStagingDomains = [...byDomain.values()];

      currentConfig.updateEdgeOptimizeConfig({
        ...existingEdgeConfig,
        stagingDomains: mergedStagingDomains,
      });
      await saveSiteConfig(site, currentConfig, log, 'updating edge optimize staging domains');
      log.info(`[edge-optimize-config/stage] Updated staging domains for site ${siteId}, count=${mergedStagingDomains.length}`);
      return ok(stageConfigs);
    } catch (error) {
      log.error(`Failed to add staging domains for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  const updateQueryIndex = async (context) => {
    const { log, env } = context;
    const { data } = context;

    try {
      if (!accessControlUtil.isLLMOAdministrator()) {
        return forbidden('Only LLMO administrators can update the query index');
      }

      if (!data || typeof data !== 'object') {
        return badRequest('Request body is required');
      }

      const { domain, fileNames } = data;

      if (!domain) {
        return badRequest('domain is required');
      }

      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return badRequest('fileNames must be a non-empty array of strings');
      }

      if (fileNames.some((f) => typeof f !== 'string' || !f.trim())) {
        return badRequest('Each fileName must be a non-empty string');
      }

      const { dataAccess } = context;
      const { Site } = dataAccess;

      const baseURL = composeBaseURL(domain);
      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        return notFound(`Site not found for domain: ${domain}`);
      }

      const config = site.getConfig();
      const llmoConfig = config.getLlmoConfig();

      if (!llmoConfig?.dataFolder) {
        return badRequest('LLMO is not onboarded for this site, dataFolder is missing');
      }

      const { dataFolder } = llmoConfig;

      await appendRowsToQueryIndex(dataFolder, fileNames, env, log);
      await previewAndPublishQueryIndex(dataFolder, env, log);

      log.info(`Successfully updated query-index.xlsx for domain ${domain} with ${fileNames.length} entries`);

      return ok({
        message: 'query-index.xlsx updated, previewed, and published successfully',
        domain,
        dataFolder,
        entriesAdded: fileNames.length,
      });
    } catch (error) {
      log.error(`Failed to update query-index for domain ${data?.domain}: ${error.message}`);
      return internalServerError(`Failed to update query-index: ${error.message}`);
    }
  };

  /**
   * GET /sites/{siteId}/llmo/probes/edge-optimize
   *
   * Edge Optimize connectivity probe — detects whether a WAF or Bot Manager is
   * blocking the AdobeEdgeOptimize/1.0 user-agent at the customer's origin.
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 200 with probe result, or 4xx/5xx on error.
   */
  const checkWafConnectivity = async (context) => {
    const { log, dataAccess } = context;
    const { Site } = dataAccess;
    const { siteId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Invalid siteId');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound(`Site with ID ${siteId} not found`);
    }

    // Intentionally no isLLMOAdministrator() check here — this endpoint is designed for
    // the customer-facing diagnostic UI so org members can diagnose their own WAF config.
    // Compare with checkEdgeOptimizeStatus (admin-only) which exposes internal routing state.
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can check this site');
    }

    const baseURL = site.getBaseURL();
    if (!baseURL) {
      return internalServerError('Site has no baseURL configured');
    }

    log.info(`[edge-optimize-probe] Starting WAF connectivity probe for site ${siteId} (${baseURL})`);

    const tokowakaClient = TokowakaClient.createFrom(context);
    const result = await tokowakaClient.checkWafConnectivity(site);

    log.info(`[edge-optimize-probe] Result for site ${siteId}: reachable=${result.reachable}, blocked=${result.blocked}`);

    return ok(result);
  };

  /**
   * POST /sites/{siteId}/llmo/edge-optimize-bootstrap-url
   * Builds a one-click CloudFormation quick-create URL (with a server-side
   * presigned template URL) the customer uses to create the cross-account
   * connector role in their own AWS account. Presigning runs with the service
   * execution role, so the template bucket stays private (no public endpoint)
   * and the customer needs no S3 access.
   * @param {object} context - Request context
   * @returns {Promise<Response>} Bootstrap details + CloudFormation quick-create URL
   */
  const getEdgeOptimizeBootstrapUrl = async (context) => {
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
      return badRequest(cleanupHeaderValue(error.message));
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

  /**
   * GET /sites/{siteId}/llmo/edge-optimize/installer-url
   * "Option B" — builds a one-click CloudFormation quick-create ("Launch Stack") URL for a
   * fully customer-managed Edge Optimize install. Unlike the assume-role wizard, this endpoint
   * makes NO cross-account calls (no AssumeRole, no SDK mutations): it only reads the site's
   * Edge Optimize config + presigns the installer template + builds a URL. Everything runs in
   * the customer's own AWS account when they launch the stack — Adobe gets no access.
   *
   * Prefills only SiteHost + EdgeOptimizeApiKey (plus sensible defaults). DistributionId and
   * DefaultOriginId are intentionally left UNSET — they are account-specific and the customer
   * fills them in the CloudFormation form (we have no cross-account access to discover them).
   * @param {object} context - Request context
   * @returns {Promise<Response>} CloudFormation quick-create URL + siteHost + presign TTL
   */
  const getEdgeOptimizeInstallerUrl = async (context) => {
    const {
      log, dataAccess, env, s3,
    } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'generate the edge optimize installer link');
      if (error) {
        return error;
      }

      const baseURL = site.getBaseURL();
      const metaconfig = await TokowakaClient.createFrom(context).fetchMetaconfig(baseURL);
      const rawApiKey = metaconfig?.apiKeys?.[0];
      if (!hasText(rawApiKey)) {
        return badRequest('Site has no Edge Optimize API key — enable Edge Optimize first');
      }
      // TRIM the apiKey — a stray newline/space breaks the EO header at the edge.
      const apiKey = String(rawApiKey).trim();
      const siteHost = String(calculateForwardedHost(baseURL, log) || '').trim();

      if (!s3?.s3Client) {
        return badRequest('Edge optimize template hosting is not configured for this environment');
      }

      // Presign the (private) installer template so the customer's CloudFormation can read it
      // cross-account via the signature — no public bucket, no customer S3 access.
      const bucket = env.EDGE_OPTIMIZE_TEMPLATE_BUCKET;
      if (!hasText(bucket)) {
        return badRequest('Edge optimize template hosting is not configured for this environment');
      }
      const key = env.EDGE_OPTIMIZE_INSTALLER_KEY || 'edgeoptimize-cloudfront-installer.yaml';
      const region = 'us-east-1'; // Lambda@Edge requirement
      // Longer TTL than the role link — this is a one-shot launch the customer opens directly.
      const presignTtlSeconds = Number(env.EDGE_OPTIMIZE_PRESIGN_TTL || 3600);

      const templateUrl = await s3.getSignedUrl(
        s3.s3Client,
        new s3.GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: presignTtlSeconds },
      );

      // Prefill only SiteHost + EdgeOptimizeApiKey (+ sensible defaults). Leave DistributionId
      // and DefaultOriginId UNSET — the customer fills those in the CloudFormation form.
      const params = {
        SiteHost: siteHost,
        EdgeOptimizeApiKey: apiKey,
        TargetBehaviorPathPattern: 'default',
        TargetedPathsJson: 'null',
        RestoreDistributionOnDelete: 'true',
      };
      const qs = new URLSearchParams();
      qs.set('templateURL', templateUrl);
      qs.set('stackName', 'edgeoptimize');
      Object.entries(params).forEach(([k, v]) => qs.set(`param_${k}`, v));
      const quickCreateUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${qs.toString()}`;

      log.info(`[edge-optimize-installer-url] Generated installer URL for site ${siteId}`);

      return ok({ quickCreateUrl, siteHost, presignTtlSeconds });
    } catch (error) {
      log.error(`Failed to generate edge optimize installer URL for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Verify the customer's cross-account connector role is assumable. Used by the wizard's
  // "Allow access" step, which polls this after the customer creates the role via CloudFormation.
  const connectEdgeOptimize = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
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
  const getEdgeOptimizeDistributions = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Run the wizard's pre-flight checks: confirm the connector role is assumable and that it grants
  // CloudFront read access. Each check reports ok/false individually so the wizard can show a
  // per-check status rather than failing the whole step on a single problem.
  const checkEdgeOptimizePrerequisites = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Read the origins configured on a customer's CloudFront distribution so the wizard's
  // "Review origins" step can show them and flag whether an Edge Optimize origin already exists.
  const getEdgeOptimizeOrigins = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Read the cache behaviors (default + ordered) configured on a customer's CloudFront
  // distribution so the wizard's "Review routing" step can show how traffic is currently routed.
  const getEdgeOptimizeBehaviors = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Add the Edge Optimize origin to the selected distribution (mutation). Idempotent: returns
  // { created: false, alreadyExisted: true } when the origin is already present. Used by the
  // wizard's "Create Edge Optimize origin" step.
  const createEdgeOptimizeOriginHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'create the edge optimize origin');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the site — no UI input. Without them Verify never goes green.
      const baseURL = site.getBaseURL();
      const tokowakaClient = TokowakaClient.createFrom(context);
      const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
      const apiKey = metaconfig?.apiKeys?.[0];
      if (!hasText(apiKey)) {
        return badRequest('Site has no Edge Optimize API key — enable Edge Optimize for this site first');
      }
      const forwardedHost = calculateForwardedHost(baseURL, log);

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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Create/update + publish the `edgeoptimize-routing` CloudFront Function (mutation, idempotent).
  // Needs the default-behavior target origin id so the function's failover origin group is correct.
  const createEdgeOptimizeRoutingFunctionHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const targetedPaths = Array.isArray(context.data?.targetedPaths)
      ? context.data.targetedPaths
      : null;
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Ensure the Edge Optimize headers are forwarded by the selected behavior's cache policy
  // (mutation, idempotent). Used by the wizard's "Apply cache headers" step.
  const applyEdgeOptimizeCacheHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const pathPattern = String(context.data?.pathPattern || '').trim() || 'default';
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Create/update + publish the `edgeoptimize-origin` Lambda@Edge function and its exec role
  // (mutation, idempotent). Returns the versioned ARN the associate step needs.
  const createEdgeOptimizeLambdaHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }

    const distributionId = String(context.data?.distributionId || '').trim();
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Read-only status for the Lambda@Edge function so the wizard can detect on entry (and poll
  // after a slow/timed-out create) whether it already exists with a published version.
  const getEdgeOptimizeLambdaStatusHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }

    const distributionId = String(context.data?.distributionId || '').trim();
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Associate the routing CloudFront Function (viewer-request) and Lambda@Edge (origin-request/
  // response, versioned ARN) onto the user-selected behavior (mutation). Used by "Associate".
  const applyEdgeOptimizeAssociationsHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const pathPattern = String(context.data?.pathPattern || '').trim() || 'default';
    const lambdaVersionArn = String(context.data?.lambdaVersionArn || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
    }
    if (!hasText(lambdaVersionArn)) {
      return badRequest('lambdaVersionArn is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Verify end-to-end routing by probing the distribution as a bot vs a human and inspecting the
  // x-edgeoptimize-* headers. Always returns 200 with { passed }; success requires a request-id.
  const verifyEdgeOptimizeRoutingHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Idempotent, step-on-poll orchestrator for the CloudFront "Deploy routing" wizard. The FE calls
  // this once then polls it (~30s); each call advances origin → function → cache → lambda →
  // associate → verify as far as it safely can (well under the gateway's ~60s timeout) and returns
  // per-step status. Safe to call repeatedly — gated steps never re-mutate completed work. The FE
  // passes the customer's selected distribution, failover origin, and behavior explicitly; the EO
  // API key + forwarded host are derived server-side from the site (no UI input).
  const deployEdgeOptimizeHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const originId = String(context.data?.originId || '').trim();
    const behavior = String(context.data?.behavior || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'deploy edge optimize routing');
      if (error) {
        return error;
      }

      // The EO origin needs custom headers so the routing function's request authenticates to Edge
      // Optimize (x-edgeoptimize-api-key) and resolves the customer host (x-forwarded-host). Both
      // are derived server-side from the site — no UI input. Without them Verify never goes green.
      const baseURL = site.getBaseURL();
      const tokowakaClient = TokowakaClient.createFrom(context);
      const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
      const apiKey = metaconfig?.apiKeys?.[0];
      if (!hasText(apiKey)) {
        return badRequest('Site has no Edge Optimize API key — enable Edge Optimize for this site first');
      }
      const forwardedHost = calculateForwardedHost(baseURL, log);

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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Read-only "preview" for the wizard's "Review & Deploy" screen. Mirrors the deploy handler (same
  // validation + gate + role assumption + server-derived EO origin headers), but calls the
  // NON-mutating planEdgeOptimizeDeploy and returns the per-step plan + canProceed/blocker so the
  // FE can show exactly what will happen before the customer commits.
  const planEdgeOptimizeHandler = async (context) => {
    const { log, dataAccess, env } = context;
    const { siteId } = context.params;
    const { Site } = dataAccess;
    const accountId = String(context.data?.accountId || '').replace(/\D/g, '');
    const externalId = String(context.data?.externalId || '').trim();
    const distributionId = String(context.data?.distributionId || '').trim();
    const originId = String(context.data?.originId || '').trim();
    const behavior = String(context.data?.behavior || '').trim();
    const roleName = env?.EDGE_OPTIMIZE_ROLE_NAME || undefined;
    const originDomain = env?.EDGE_OPTIMIZE_ORIGIN_DOMAIN || 'live.edgeoptimize.net';

    if (accountId.length !== 12) {
      return badRequest('accountId must be a 12-digit AWS account ID');
    }
    if (!hasText(externalId)) {
      return badRequest('externalId is required');
    }
    if (!hasText(distributionId)) {
      return badRequest('distributionId is required');
    }
    if (!hasText(originId)) {
      return badRequest('originId is required');
    }
    if (!hasText(behavior)) {
      return badRequest('behavior is required');
    }

    try {
      const { error, site } = await gateEdgeOptimizeWizard(siteId, Site, 'preview edge optimize routing');
      if (error) {
        return error;
      }

      // Derive the EO origin headers server-side (same as deploy) so the origin step of the plan
      // reflects whether the existing origin already carries the right headers.
      const baseURL = site.getBaseURL();
      const tokowakaClient = TokowakaClient.createFrom(context);
      const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);
      const apiKey = metaconfig?.apiKeys?.[0];
      if (!hasText(apiKey)) {
        return badRequest('Site has no Edge Optimize API key — enable Edge Optimize for this site first');
      }
      const forwardedHost = calculateForwardedHost(baseURL, log);

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
      return ok(result);
    } catch (error) {
      log.error(`[edge-optimize-plan] Failed for site ${siteId}:`, error);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  /**
   * GET /sites/{siteId}/llmo/edge-optimize/permissions
   * Powers the wizard's "View Permissions" panel. Returns a curated, human-friendly manifest of the
   * AWS permissions the connector role grants (read from a static JSON object in the template S3
   * bucket) plus the Adobe principal ARN that will assume the role. Read-only — gated on site
   * access + LLMO admin (like getEdgeOptimizeBootstrapUrl). No cross-account calls.
   * @param {object} context - Request context
   * @returns {Promise<Response>} { adobeAccount, manifest } or a 400 on a config/read failure.
   */
  const getEdgeOptimizePermissionsHandler = async (context) => {
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
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  return {
    getEdgeOptimizeBootstrapUrl,
    getEdgeOptimizeInstallerUrl,
    connectEdgeOptimize,
    getEdgeOptimizeDistributions,
    checkEdgeOptimizePrerequisites,
    getEdgeOptimizeOrigins,
    getEdgeOptimizeBehaviors,
    createEdgeOptimizeOrigin: createEdgeOptimizeOriginHandler,
    createEdgeOptimizeRoutingFunction: createEdgeOptimizeRoutingFunctionHandler,
    applyEdgeOptimizeCache: applyEdgeOptimizeCacheHandler,
    createEdgeOptimizeLambda: createEdgeOptimizeLambdaHandler,
    getEdgeOptimizeLambdaStatus: getEdgeOptimizeLambdaStatusHandler,
    applyEdgeOptimizeAssociations: applyEdgeOptimizeAssociationsHandler,
    verifyEdgeOptimizeRouting: verifyEdgeOptimizeRoutingHandler,
    deployEdgeOptimize: deployEdgeOptimizeHandler,
    planEdgeOptimize: planEdgeOptimizeHandler,
    getEdgeOptimizePermissions: getEdgeOptimizePermissionsHandler,
    getLlmoSheetData,
    queryLlmoSheetData,
    getLlmoGlobalSheetData,
    getLlmoConfig,
    getLlmoQuestions,
    addLlmoQuestion,
    removeLlmoQuestion,
    patchLlmoQuestion,
    getLlmoCustomerIntent,
    addLlmoCustomerIntent,
    removeLlmoCustomerIntent,
    patchLlmoCustomerIntent,
    patchLlmoCdnLogsFilter,
    patchLlmoCdnBucketConfig,
    updateLlmoConfig,
    onboardCustomer,
    onboardSiteOnly,
    offboardCustomer,
    queryFiles,
    patchLlmoDataRow,
    getLlmoRationale,
    getBrandClaims,
    getDemoBrandPresence,
    getDemoRecommendations,
    createOrUpdateEdgeConfig,
    getEdgeConfig,
    createOrUpdateStageEdgeConfig,
    getStrategy,
    saveStrategy,
    checkEdgeOptimizeStatus,
    checkWafConnectivity,
    markOpportunitiesReviewed,
    updateQueryIndex,
  };
}

export default LlmoController;
