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

import {
  ok, badRequest, forbidden, createResponse, notFound,
} from '@adobe/spacecat-shared-http-utils';
import {
  SPACECAT_USER_AGENT,
  tracingFetch as fetch,
  hasText,
  isObject,
  llmoConfig as llmo,
  schemas,
  composeBaseURL,
  isoCalendarWeek,
} from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import crypto from 'crypto';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../../support/access-control-util.js';
import { triggerBrandProfileAgent } from '../../support/brand-profile-trigger.js';
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
} from './llmo-onboarding.js';
import { queryLlmoFiles } from './llmo-query-handler.js';
import { updateModifiedByDetails } from './llmo-config-metadata.js';

const { readConfig, writeConfig } = llmo;
const { llmoConfig: llmoConfigSchema } = schemas;

function LlmoController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  // Helper function to get site and validate LLMO config
  const getSiteAndValidateLlmo = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site } = dataAccess;

    const site = await Site.findById(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    if (!llmoConfig?.dataFolder) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }
    const hasAccessToElmo = await accessControlUtil.hasAccess(
      site,
      '',
      EntitlementModel.PRODUCT_CODES.LLMO,
    );
    if (!hasAccessToElmo) {
      throw new Error('Only users belonging to the organization can view its sites');
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
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
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
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      // Return the data, pass through any compression headers from upstream
      return ok(data, {
        ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
      });
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
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
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
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
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
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
      return badRequest(error.message);
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
      await getSiteAndValidateLlmo(context);

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
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      log.info(`Successfully proxied global data for siteId: ${siteId}, sheetURL: ${sheetURL}`);
      // Return the data and let the framework handle the compression
      return ok(data, {
        ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
      });
    } catch (error) {
      log.error(`Error proxying global data for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO config endpoint
  const getLlmoConfig = async (context) => {
    const { log, s3 } = context;
    const { siteId } = context.params;
    const version = context.data?.version;
    try {
      if (!s3 || !s3.s3Client) {
        return badRequest('LLMO config storage is not configured for this environment');
      }

      log.info(`Fetching LLMO config from S3 for siteId: ${siteId}${version != null ? ` with version: ${version}` : ''}`);
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
      return badRequest(error.message);
    }
  };

  async function updateLlmoConfig(context) {
    const {
      log,
      s3,
      data,
      pathInfo,
    } = context;
    const { siteId } = context.params;

    const userId = context.attributes?.authInfo?.getProfile()?.sub || 'system';

    try {
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
        `${stats.categoryUrls.total} category URLs`,
      ];
      const configSummary = summaryParts.join(', ');

      log.info(`User ${userId} modifying customer configuration (${configSummary}) for siteId: ${siteId}, version: ${version}`);
      return ok({ version });
    } catch (error) {
      const msg = `${error?.message || /* c8 ignore next */ error}`;
      log.error(`User ${userId} error updating llmo config for siteId: ${siteId}, error: ${msg}`);
      return badRequest(msg);
    }
  }

  // Handles requests to the LLMO questions endpoint, returns both human and ai questions
  const getLlmoQuestions = async (context) => {
    const { llmoConfig } = await getSiteAndValidateLlmo(context);
    return ok(llmoConfig.questions || {});
  };

  // Handles requests to the LLMO questions endpoint, adds a new question
  // the body format is { Human: [question1, question2], AI: [question3, question4] }
  const addLlmoQuestion = async (context) => {
    const { log } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

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
    const { site, config } = await getSiteAndValidateLlmo(context);

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
    const { site, config } = await getSiteAndValidateLlmo(context);

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
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
      return ok(llmoConfig.customerIntent || []);
    } catch (error) {
      if (error.message === 'Only users belonging to the organization can view its sites') {
        return forbidden(error.message);
      }
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO customer intent endpoint, adds new customer intent items
  const addLlmoCustomerIntent = async (context) => {
    const { log } = context;

    try {
      const { site, config } = await getSiteAndValidateLlmo(context);

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
      if (error.message === 'Only users belonging to the organization can view its sites') {
        return forbidden(error.message);
      }
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO customer intent endpoint, removes a customer intent item
  const removeLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;

    try {
      const { site, config } = await getSiteAndValidateLlmo(context);

      validateCustomerIntentKey(config, intentKey);

      // remove the customer intent using the config method
      config.removeLlmoCustomerIntent(intentKey);

      await saveSiteConfig(site, config, log, 'removing customer intent');

      // return the updated llmoConfig customer intent
      return ok(config.getLlmoConfig().customerIntent || []);
    } catch (error) {
      if (error.message === 'Only users belonging to the organization can view its sites') {
        return forbidden(error.message);
      }
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO customer intent endpoint, updates a customer intent item
  const patchLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;
    const { data } = context;

    try {
      const { site, config } = await getSiteAndValidateLlmo(context);

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
      if (error.message === 'Only users belonging to the organization can view its sites') {
        return forbidden(error.message);
      }
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO CDN logs filter endpoint, updates CDN logs filter configuration
  const patchLlmoCdnLogsFilter = async (context) => {
    const { log } = context;
    const { data } = context;
    const { siteId } = context.params;

    try {
      const { site, config } = await getSiteAndValidateLlmo(context);

      if (!isObject(data)) {
        return badRequest('Update data must be provided as an object');
      }

      const { cdnlogsFilter } = data;

      config.updateLlmoCdnlogsFilter(cdnlogsFilter);

      await saveSiteConfig(site, config, log, 'updating CDN logs filter');

      return ok(config.getLlmoConfig().cdnlogsFilter || []);
    } catch (error) {
      log.error(`Error updating CDN logs filter for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
    }
  };

  // Handles requests to the LLMO CDN bucket config endpoint, updates CDN bucket configuration
  const patchLlmoCdnBucketConfig = async (context) => {
    const { log } = context;
    const { data } = context;
    const { siteId } = context.params;

    try {
      const { site, config } = await getSiteAndValidateLlmo(context);

      if (!isObject(data)) {
        return badRequest('Update data must be provided as an object');
      }

      const { cdnBucketConfig } = data;

      config.updateLlmoCdnBucketConfig(cdnBucketConfig);

      await saveSiteConfig(site, config, log, 'updating CDN logs bucket config');

      return ok(config.getLlmoConfig().cdnBucketConfig || {});
    } catch (error) {
      log.error(`Error updating CDN bucket config for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
    }
  };

  /**
   * Onboards a new customer to LLMO.
   * This endpoint handles the complete onboarding process for net new customers
   * including organization validation, site creation, and LLMO configuration.
   * @param {object} context - The request context.
   * @returns {Promise<Response>} The onboarding response.
   */
  const onboardCustomer = async (context) => {
    const { log, env, attributes } = context;
    const { data } = context;

    try {
      // Validate required fields
      if (!data || typeof data !== 'object') {
        return badRequest('Onboarding data is required');
      }

      const { domain, brandName } = data;

      if (!domain || !brandName) {
        return badRequest('domain and brandName are required');
      }

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

      const imsOrgId = `${profile.tenants[0].id}@AdobeOrg`;

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
        { domain, brandName, imsOrgId },
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
        status: 'completed',
        createdAt: new Date().toISOString(),
        brandProfileExecutionName,
      });
    } catch (error) {
      log.error(`Error during LLMO onboarding: ${error.message}`);
      return badRequest(error.message);
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
      const { site, config } = await getSiteAndValidateLlmo(context);

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
      return badRequest(error.message);
    }
  };

  const queryFiles = async (context) => {
    const { log } = context;
    const { siteId } = context.params;
    try {
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
      const { data, headers } = await queryLlmoFiles(context, llmoConfig);
      return ok(data, headers);
    } catch (error) {
      log.error(`Error during LLMO cached query for site ${siteId}: ${error.message}`);
      return badRequest(error.message);
    }
  };

  // Helper function to get week information from audit ID
  const getWeekFromAuditId = async (auditId, context) => {
    const { dataAccess, log } = context;
    const { Audit } = dataAccess;
    const helperStart = Date.now();

    log.debug(`[LLMO-ATHENA-HELPER] Starting week calculation for audit: ${auditId}`);

    try {
      // Step 1: Look up the audit
      log.debug(`[LLMO-ATHENA-HELPER] Looking up audit ${auditId} in database`);
      const auditLookupStart = Date.now();
      const audit = await Audit.findById(auditId);
      const auditLookupDuration = Date.now() - auditLookupStart;

      if (!audit) {
        log.warn(`[LLMO-ATHENA-HELPER] Audit ${auditId} not found in database - lookup duration: ${auditLookupDuration}ms`);
        throw new Error(`Audit ${auditId} not found`);
      }

      log.debug(`[LLMO-ATHENA-HELPER] Successfully found audit ${auditId} - lookup duration: ${auditLookupDuration}ms`);
      // Step 2: Get the auditedAt timestamp
      const auditedAt = audit.getAuditedAt(); // ISO string like "2025-01-15T10:30:00.000Z"
      const auditType = audit.getAuditType();
      const siteId = audit.getSiteId();
      log.debug(`[LLMO-ATHENA-HELPER] Audit ${auditId} details - auditedAt: ${auditedAt}, type: ${auditType}, siteId: ${siteId}`);

      if (!auditedAt) {
        log.warn(`[LLMO-ATHENA-HELPER] Audit ${auditId} has no auditedAt timestamp`);
        throw new Error(`Audit ${auditId} has no auditedAt timestamp`);
      }

      // Step 3: Parse and calculate week number using shared utility
      log.debug(`[LLMO-ATHENA-HELPER] Calculating ISO week for audit ${auditId} from date: ${auditedAt}`);
      const weekCalcStart = Date.now();
      const date = new Date(auditedAt);

      if (Number.isNaN(date.getTime())) {
        log.warn(`[LLMO-ATHENA-HELPER] Invalid date format for audit ${auditId}: ${auditedAt}`);
        throw new Error(`Invalid date format for audit ${auditId}: ${auditedAt}`);
      }

      const { week, year } = isoCalendarWeek(date);
      const weekCalcDuration = Date.now() - weekCalcStart;
      const weekIdentifier = `w${String(week).padStart(2, '0')}-${year}`;
      log.debug(
        `[LLMO-ATHENA-HELPER] Week calculation completed for audit ${auditId} - week: ${week}, year: ${year}, identifier: ${weekIdentifier} - calc duration: ${weekCalcDuration}ms`,
      );

      const helperDuration = Date.now() - helperStart;
      log.debug(`[LLMO-ATHENA-HELPER] Helper function completed for audit ${auditId} - total duration: ${helperDuration}ms`);

      return {
        auditId,
        auditedAt,
        week,
        year,
        weekIdentifier,
        auditType,
        siteId,
      };
    } catch (error) {
      const helperDuration = Date.now() - helperStart;
      log.error(`[LLMO-ATHENA-HELPER] Helper function failed for audit ${auditId} - duration: ${helperDuration}ms, error: ${error.message}`);
      throw error;
    }
  };

  // Handles requests to the LLMO Athena endpoint
  // Checks S3 folder for specific siteId, retrieves audits and returns week stats
  const getLlmoAthena = async (context) => {
    const { log, s3, env } = context;
    const { siteId } = context.params;
    const startTime = Date.now();

    log.info(`[LLMO-ATHENA] Starting request for siteId: ${siteId}`);

    try {
      // Validate LLMO access
      log.info(`[LLMO-ATHENA] Validating LLMO access for siteId: ${siteId}`);
      const validationStart = Date.now();
      await getSiteAndValidateLlmo(context);
      const validationDuration = Date.now() - validationStart;
      log.info(`[LLMO-ATHENA] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

      if (!s3 || !s3.s3Client) {
        log.error(`[LLMO-ATHENA] S3 configuration missing for siteId: ${siteId}`);
        return badRequest('S3 storage is not configured for this environment');
      }

      log.info(`[LLMO-ATHENA] S3 configuration validated for siteId: ${siteId}, bucket: ${s3.s3Bucket}`);

      // Check S3 folder for the specific siteId
      const s3Bucket = `spacecat-${env.ENV}-mystique-assets`;
      const s3FolderPath = `audit_data/${siteId}/`;
      log.info(`[LLMO-ATHENA] Checking S3 folder: ${s3FolderPath} for siteId: ${siteId}`);

      try {
        // List objects in the S3 folder - USE DELIMITER to get only immediate children
        const listParams = {
          Bucket: s3Bucket,
          Prefix: s3FolderPath,
          Delimiter: '/', // This is the key - only get immediate children
        };

        log.info(`[LLMO-ATHENA] Listing S3 objects with params: ${JSON.stringify(listParams)} for siteId: ${siteId}`);
        const s3ListStart = Date.now();
        const listCommand = new s3.ListObjectsV2Command(listParams);
        const s3Objects = await s3.s3Client.send(listCommand);
        const s3ListDuration = Date.now() - s3ListStart;

        log.info(`[LLMO-ATHENA] S3 listObjectsV2 completed for siteId: ${siteId} - duration: ${s3ListDuration}ms, prefixes found: ${s3Objects.CommonPrefixes?.length || 0}, objects found: ${s3Objects.Contents?.length || 0}`);

        // We'll check for empty audit IDs after extraction, not here

        // Log S3 structure for debugging
        log.info(`[LLMO-ATHENA] S3 Response structure for siteId: ${siteId}:`);
        log.info(`[LLMO-ATHENA] - CommonPrefixes count: ${s3Objects.CommonPrefixes?.length || 0}`);
        log.info(`[LLMO-ATHENA] - Contents count: ${s3Objects.Contents?.length || 0}`);

        if (s3Objects.CommonPrefixes && s3Objects.CommonPrefixes.length > 0) {
          const samplePrefixes = s3Objects.CommonPrefixes.slice(0, 5)
            .map((prefix) => prefix.Prefix);
          log.info(`[LLMO-ATHENA] Sample CommonPrefixes for siteId: ${siteId}:`);
          log.info(`${JSON.stringify(samplePrefixes)}`);
        }

        if (s3Objects.Contents && s3Objects.Contents.length > 0) {
          const sampleContents = s3Objects.Contents.slice(0, 5).map((obj) => ({
            key: obj.Key,
            size: obj.Size,
          }));
          log.info(`[LLMO-ATHENA] Sample Contents for siteId: ${siteId}: ${JSON.stringify(sampleContents, null, 2)}`);
        }

        // Extract audit IDs - handle both folder structure and direct files
        const auditIds = [];

        // First, try to extract from CommonPrefixes (folder structure: audit_data/siteId/auditId/)
        if (s3Objects.CommonPrefixes && s3Objects.CommonPrefixes.length > 0) {
          const prefixCount = s3Objects.CommonPrefixes.length;
          log.info(`[LLMO-ATHENA] Extracting audit IDs from ${prefixCount} S3 prefixes for siteId: ${siteId}`);
          s3Objects.CommonPrefixes.forEach((prefix) => {
            // prefix.Prefix will be like "audit_data/siteId/auditId/"
            const prefixPath = prefix.Prefix;
            // Remove the s3FolderPath and trailing slash to get just the auditId
            const auditId = prefixPath.replace(s3FolderPath, '').replace(/\/$/, '');
            if (auditId && auditId !== '' && !auditId.includes('/')) { // Ensure it's a direct child
              auditIds.push(auditId);
            }
          });
        }

        // If no prefixes found, fall back to extracting from Contents (file structure)
        if (auditIds.length === 0 && s3Objects.Contents && s3Objects.Contents.length > 0) {
          const contentsCount = s3Objects.Contents.length;
          log.info(`[LLMO-ATHENA] No prefixes found, extracting audit IDs from ${contentsCount} S3 objects for siteId: ${siteId}`);
          s3Objects.Contents.forEach((obj) => {
            const key = obj.Key;
            // Skip if it's not a direct child of the siteId folder
            const relativePath = key.replace(s3FolderPath, '');
            const pathParts = relativePath.split('/');

            // Only process direct children (no nested paths)
            if (pathParts.length === 1 && pathParts[0].endsWith('.json')) {
              const auditId = pathParts[0].replace('.json', '');
              if (auditId && auditId !== '') {
                auditIds.push(auditId);
              }
            }
          });
        }

        log.info(`[LLMO-ATHENA] Final result: Extracted ${auditIds.length} audit IDs for siteId: ${siteId}`);

        if (auditIds.length === 0) {
          log.warn(`[LLMO-ATHENA] No valid audit IDs found after filtering for siteId: ${siteId}`);
          const totalDuration = Date.now() - startTime;
          log.info(`[LLMO-ATHENA] Request completed (no valid IDs) for siteId: ${siteId} - total duration: ${totalDuration}ms`);
          return ok({
            siteId,
            message: 'No valid audit IDs found in S3 folder',
            audits: [],
            weekStats: {},
            s3FolderPath,
            processedAt: new Date().toISOString(),
            processingStats: {
              totalDuration,
              validationDuration,
              s3ListDuration,
              s3ObjectsFound: (s3Objects.CommonPrefixes?.length || 0)
                + (s3Objects.Contents?.length || 0),
              validAuditIds: 0,
            },
          });
        }

        // Log sample audit IDs
        const sampleAuditIds = auditIds.slice(0, 5);
        log.info(`[LLMO-ATHENA] Sample audit IDs for siteId: ${siteId}: ${JSON.stringify(sampleAuditIds)}`);

        // Get week information for each audit
        const auditWeekData = [];
        const weekStats = {};

        // Process audits in parallel to avoid await in loop
        log.info(`[LLMO-ATHENA] Starting parallel processing of ${auditIds.length} audits for siteId: ${siteId}`);
        const auditProcessingStart = Date.now();

        const auditPromises = auditIds.map(async (auditId) => {
          const auditStart = Date.now();
          try {
            log.debug(`[LLMO-ATHENA] Processing audit ${auditId} for siteId: ${siteId}`);
            const weekInfo = await getWeekFromAuditId(auditId, context);
            const auditDuration = Date.now() - auditStart;
            log.debug(`[LLMO-ATHENA] Successfully processed audit ${auditId} for siteId: ${siteId} - duration: ${auditDuration}ms`);
            return {
              success: true, weekInfo, auditId, duration: auditDuration,
            };
          } catch (auditError) {
            const auditDuration = Date.now() - auditStart;
            log.warn(`[LLMO-ATHENA] Failed to process audit ${auditId} for siteId: ${siteId} - duration: ${auditDuration}ms, error: ${auditError.message}`);
            return {
              success: false, auditId, error: auditError.message, duration: auditDuration,
            };
          }
        });

        const auditResults = await Promise.all(auditPromises);
        const auditProcessingDuration = Date.now() - auditProcessingStart;

        const successfulAudits = auditResults.filter((result) => result.success);
        const failedAudits = auditResults.filter((result) => !result.success);

        log.info(
          `[LLMO-ATHENA] Audit processing completed for siteId: ${siteId} - duration: ${auditProcessingDuration}ms, successful: ${successfulAudits.length}, failed: ${failedAudits.length}`,
        );

        if (failedAudits.length > 0) {
          const failedAuditIds = failedAudits.map((result) => result.auditId).slice(0, 10);
          const moreFailedCount = failedAudits.length > 10 ? ` (and ${failedAudits.length - 10} more)` : '';
          log.warn(`[LLMO-ATHENA] Failed audit IDs for siteId: ${siteId}: ${JSON.stringify(failedAuditIds)}${moreFailedCount}`);
        }

        // Process successful results
        log.info(`[LLMO-ATHENA] Aggregating week statistics from ${successfulAudits.length} successful audits for siteId: ${siteId}`);
        const aggregationStart = Date.now();

        auditResults.forEach((result) => {
          if (result.success) {
            const { weekInfo } = result;
            auditWeekData.push(weekInfo);

            // Aggregate week statistics
            const { weekIdentifier, auditType } = weekInfo;

            if (!weekStats[weekIdentifier]) {
              weekStats[weekIdentifier] = {
                week: weekInfo.week,
                year: weekInfo.year,
                weekIdentifier,
                auditCounts: {},
                totalAudits: 0,
              };
              log.debug(`[LLMO-ATHENA] Created new week stats for ${weekIdentifier} for siteId: ${siteId}`);
            }

            if (!weekStats[weekIdentifier].auditCounts[auditType]) {
              weekStats[weekIdentifier].auditCounts[auditType] = 0;
            }

            weekStats[weekIdentifier].auditCounts[auditType] += 1;
            weekStats[weekIdentifier].totalAudits += 1;
          }
        });

        const aggregationDuration = Date.now() - aggregationStart;
        const totalWeeks = Object.keys(weekStats).length;
        const totalAuditTypes = new Set(auditWeekData.map((audit) => audit.auditType)).size;

        log.info(`[LLMO-ATHENA] Week statistics aggregation completed for siteId: ${siteId} - duration: ${aggregationDuration}ms, weeks: ${totalWeeks}, audit types: ${totalAuditTypes}`);

        // Log week statistics summary
        const weekSummary = Object.entries(weekStats).map(([week, stats]) => ({
          week,
          totalAudits: stats.totalAudits,
          auditTypes: Object.keys(stats.auditCounts),
        }));
        log.info(`[LLMO-ATHENA] Week statistics summary for siteId: ${siteId}: ${JSON.stringify(weekSummary)}`);

        const totalDuration = Date.now() - startTime;
        log.info(`[LLMO-ATHENA] Request completed successfully for siteId: ${siteId} - total duration: ${totalDuration}ms, processed audits: ${auditWeekData.length}`);

        return ok({
          siteId,
          message: `Found ${auditWeekData.length} audits with week statistics`,
          audits: auditWeekData,
          weekStats,
          s3FolderPath,
          processedAt: new Date().toISOString(),
          processingStats: {
            totalDuration,
            validationDuration,
            s3ListDuration,
            auditProcessingDuration,
            aggregationDuration,
            s3ObjectsFound: s3Objects.Contents.length,
            validAuditIds: auditIds.length,
            successfulAudits: successfulAudits.length,
            failedAudits: failedAudits.length,
            totalWeeks,
            totalAuditTypes,
          },
        });
      } catch (s3Error) {
        const totalDuration = Date.now() - startTime;
        log.error(`[LLMO-ATHENA] S3 error for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${s3Error.message}, stack: ${s3Error.stack}`);
        throw new Error(`Failed to access S3 folder: ${s3Error.message}`);
      }
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      log.error(`[LLMO-ATHENA] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}, stack: ${error.stack}`);
      return badRequest(error.message);
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
    getLlmoAthena,
  };
}

export default LlmoController;
