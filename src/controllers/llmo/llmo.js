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
  ok, badRequest, forbidden, createResponse, notFound, internalServerError,
  unauthorized,
} from '@adobe/spacecat-shared-http-utils';
import {
  SPACECAT_USER_AGENT,
  tracingFetch as fetch,
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
import { getDomain } from 'tldts';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TokowakaClient, { calculateForwardedHost } from '@adobe/spacecat-shared-tokowaka-client';
import { ImsClient } from '@adobe/spacecat-shared-ims-client';
import AccessControlUtil from '../../support/access-control-util.js';
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
import { updateModifiedByDetails } from './llmo-config-metadata.js';
import { handleLlmoRationale } from './llmo-rationale.js';
import { handleBrandClaims } from './brand-claims.js';
import { handleDemoBrandPresence, handleDemoRecommendations } from './opportunity-workspace-demo.js';
import { notifyStrategyChanges } from '../../support/opportunity-workspace-notifications.js';
import {
  LLMO_CONFIG_DB_SYNC_TYPE,
  isSyncEnabledForSite,
} from './llmo-config-sync-constants.js';

const { readConfig, writeConfig } = llmo;
const { readStrategy, writeStrategy } = llmoStrategy;
const { llmoConfig: llmoConfigSchema } = schemas;

const IMS_ORG_ID_REGEX = /^[a-z0-9]{24}@AdobeOrg$/i;
const VALID_CADENCES = ['daily', 'weekly-paid', 'weekly-free'];

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

  // Handles requests to the LLMO sheet data endpoint
  const getLlmoSheetData = async (context) => {
    const { log } = context;
    const {
      siteId, dataSource, sheetType, week,
    } = context.params;
    const { env } = context;
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
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
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
          'Accept-Encoding': 'br',
        },
      });

      if (!response.ok) {
        log.debug(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      // Return the data, pass through any compression headers from upstream
      return cachedOk(data, {
        ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
      });
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message}`);
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
    const { env } = context;

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
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
          'Accept-Encoding': 'br',
        },
      });

      if (!response.ok) {
        log.debug(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      let data = await response.json();
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
      return ok(data, {
        ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
      });
    } catch (error) {
      const errorTime = Date.now();
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message} - elapsed: ${errorTime - methodStartTime}ms`);
      return badRequest(cleanupHeaderValue(error.message));
    }
  };

  // Handles requests to the LLMO global sheet data endpoint
  const getLlmoGlobalSheetData = async (context) => {
    const { log } = context;
    const { siteId, configName } = context.params;
    const { env } = context;
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
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
          'Accept-Encoding': 'br',
        },
      });

      if (!response.ok) {
        log.debug(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      log.info(`Successfully proxied global data for siteId: ${siteId}, sheetURL: ${sheetURL}`);
      // Return the data and let the framework handle the compression
      return cachedOk(data, {
        ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
      });
    } catch (error) {
      log.error(`Error proxying global data for siteId: ${siteId}, error: ${error.message}`);
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

      if (isSyncEnabledForSite(siteId)) {
        log.info(`[llmo-config-db-sync] Triggering S3-to-DB config sync for siteId: ${siteId} with dryRun: false`);
        await context.sqs.sendMessage(context.env.AUDIT_JOBS_QUEUE_URL, {
          type: LLMO_CONFIG_DB_SYNC_TYPE,
          siteId,
          dryRun: false,
        });
      } else {
        log.info(`[llmo-config-db-sync] Skipping S3-to-DB config sync for siteId: ${siteId} because it is not in ALLOWED_SITE_IDS`);
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
        domain, brandName, imsOrgId: payloadImsOrgId, cadence,
      } = data;
      const tempOnboarding = data['temp-onboarding'] === true;

      if (!domain || !brandName) {
        return badRequest('domain and brandName are required');
      }

      if (cadence && !VALID_CADENCES.includes(cadence)) {
        return badRequest(`Invalid cadence. Must be one of: ${VALID_CADENCES.join(', ')}`);
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
      });
    } catch (error) {
      log.error(`Error during LLMO onboarding: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
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
    const { siteId } = context.params;
    try {
      const siteValidation = await getSiteAndValidateLlmo(context);
      if (siteValidation.status) {
        return siteValidation;
      }
      const { llmoConfig } = siteValidation;
      const { data, headers } = await queryLlmoFiles(context, llmoConfig);
      return cachedOk(data, headers);
    } catch (error) {
      log.error(`Error during LLMO cached query for site ${siteId}: ${error.message}`);
      return badRequest(cleanupHeaderValue(error.message));
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
    const { log, dataAccess, env } = context;
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

  return {
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
    offboardCustomer,
    queryFiles,
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
    markOpportunitiesReviewed,
    updateQueryIndex,
  };
}

export default LlmoController;
