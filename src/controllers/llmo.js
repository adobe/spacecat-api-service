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

import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import {
  SPACECAT_USER_AGENT,
  tracingFetch as fetch,
  hasText,
  isObject,
} from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import crypto from 'crypto';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../support/access-control-util.js';
import { LLMO_SHEET_MAPPINGS } from '../utils/llmo-mappings.js';

const LLMO_SHEETDATA_SOURCE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';

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
    if (!await accessControlUtil.hasAccess(site, '', EntitlementModel.PRODUCT_CODES.LLMO)) {
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
    const { siteId, dataSource, sheetType } = context.params;
    const { env } = context;
    try {
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
      const sheetURL = sheetType ? `${llmoConfig.dataFolder}/${sheetType}/${dataSource}.json` : `${llmoConfig.dataFolder}/${dataSource}.json`;

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
          'Accept-Encoding': 'gzip',
        },
      });

      if (!response.ok) {
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      // Return the data and let the framework handle the compression
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
    const { siteId, dataSource, sheetType } = context.params;
    const { env } = context;

    // Start timing for the entire method
    const methodStartTime = Date.now();

    // Extract and validate request body structure
    const {
      sheets = [],
      filters = {},
      include = [],
      exclude = [],
      groupBy = [],
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
    // Apply filters to data arrays with case-insensitive exact matching
    const applyFilters = (rawData, filterFields) => {
      const data = { ...rawData };
      const filterArray = (array) => {
        const filteredArray = array.filter((item) => {
          const itemMatchesFilter = Object.entries(filterFields).every(([attr, value]) => {
            const itemValue = item[attr];
            if (itemValue == null) return false;
            return String(itemValue).toLowerCase() === String(value).toLowerCase();
          });
          return itemMatchesFilter;
        });
        return filteredArray;
      };

      if (data[':type'] === 'sheet' && data.data) {
        data.data = filterArray(data.data);
      } else if (data[':type'] === 'multi-sheet') {
        Object.keys(data).forEach((key) => {
          if (key !== ':type' && data[key]?.data) {
            data[key].data = filterArray(data[key].data);
          }
        });
      }
      return data;
    };

    // Apply inclusions to data arrays to remove specified attributes
    const applyInclusions = (rawData, includeFields) => {
      const data = { ...rawData };
      const includeFromArray = (rawArray) => {
        const includeResult = rawArray.map((item) => {
          const newItem = {};
          includeFields.forEach((fieldName) => {
            const value = item[fieldName];
            if (value) {
              newItem[fieldName] = item[fieldName];
            }
          });
          return newItem;
        });
        return includeResult;
      };

      if (data[':type'] === 'sheet' && data.data) {
        data.data = includeFromArray(data.data);
      } else if (data[':type'] === 'multi-sheet') {
        Object.keys(data).forEach((key) => {
          if (key !== ':type' && data[key]?.data) {
            data[key].data = includeFromArray(data[key].data);
          }
        });
      }
      return data;
    };

    // Apply exclusions to data arrays to remove specified attributes
    const applyExclusions = (rawData, excludeFields) => {
      const data = { ...rawData };
      const excludeFromArray = (array) => array.map((item) => {
        const filteredItem = { ...item };
        excludeFields.forEach((attr) => {
          delete filteredItem[attr];
        });
        return filteredItem;
      });

      if (data[':type'] === 'sheet' && data.data) {
        data.data = excludeFromArray(data.data);
      } else if (data[':type'] === 'multi-sheet') {
        Object.keys(data).forEach((key) => {
          if (key !== ':type' && data[key]?.data) {
            data[key].data = excludeFromArray(data[key].data);
          }
        });
      }
      return data;
    };

    // Apply groups to data arrays to group by specified attributes
    const applyGroups = (rawData, groupByFields) => {
      const data = { ...rawData };

      const groupArray = (array) => {
        // Create a map to group items by the combination of grouping attributes
        const groupMap = new Map();

        array.forEach((item) => {
          // Create a key from the grouping attributes
          const groupKey = groupByFields.map((attr) => `${attr}:${item[attr] ?? 'null'}`).join('|');

          // Extract grouping attributes (ensure they're always present)
          const groupingAttributes = {};
          groupByFields.forEach((attr) => {
            // Use null instead of undefined for JSON serialization
            groupingAttributes[attr] = item[attr] ?? null;
          });

          // Create record without grouping attributes
          const record = { ...item };
          groupByFields.forEach((attr) => {
            delete record[attr];
          });

          // Add to group
          if (!groupMap.has(groupKey)) {
            groupMap.set(groupKey, {
              ...groupingAttributes,
              records: [],
            });
          }

          groupMap.get(groupKey).records.push(record);
        });

        // Convert map to array
        return Array.from(groupMap.values());
      };

      if (data[':type'] === 'sheet' && data.data) {
        data.data = groupArray(data.data);
      } else if (data[':type'] === 'multi-sheet') {
        Object.keys(data).forEach((key) => {
          if (key !== ':type' && data[key]?.data) {
            data[key].data = groupArray(data[key].data);
          }
        });
      }

      return data;
    };

    // Apply mappings to data arrays to transform field names and values
    const applyMappings = (rawData, mappingConfig) => {
      const data = { ...rawData };

      const mapArray = (array, mappings) => array.map((item) => {
        const mappedItem = { ...item };

        Object.entries(mappings).forEach(([originalField, newField]) => {
          mappedItem[newField] = item[originalField];
          delete mappedItem[originalField];
        });

        return mappedItem;
      });

      Object.keys(data).forEach((key) => {
        if (key !== ':type' && data[key]?.data && mappingConfig.mappings?.[key]) {
          const mappings = mappingConfig.mappings[key];
          data[key].data = mapArray(data[key].data, mappings);
        }
      });

      return data;
    };

    try {
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
      const sheetURL = sheetType ? `${llmoConfig.dataFolder}/${sheetType}/${dataSource}.json` : `${llmoConfig.dataFolder}/${dataSource}.json`;

      // Add limit, offset and sheet query params to the url
      const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`);

      // This endpoint does not support limit as it needs to go through
      // all records to apply filters, exclusions and grouping
      const FIXED_LLMO_LIMIT = 1000000;
      url.searchParams.set('limit', FIXED_LLMO_LIMIT);

      // Log setup completion time
      const setupTime = Date.now();
      log.info(`LLMO query setup completed - elapsed: ${setupTime - methodStartTime}ms`);

      // Fetch data from the external endpoint using the dataFolder from config
      const fetchStartTime = Date.now();
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
          'Accept-Encoding': 'gzip',
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
      log.info('Looking for mapping for dataSource: ', dataSource, 'mappings: ', LLMO_SHEET_MAPPINGS);
      const mapping = LLMO_SHEET_MAPPINGS.find((m) => dataSource.toLowerCase().includes(m.pattern));
      if (mapping) {
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

      // Return the data and let the framework handle the compression
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
          'Accept-Encoding': 'gzip',
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
    const { log } = context;
    const { siteId } = context.params;
    try {
      const { llmoConfig } = await getSiteAndValidateLlmo(context);
      return ok(llmoConfig);
    } catch (error) {
      log.error(`Error getting llmo config for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
    }
  };

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
    const { llmoConfig } = await getSiteAndValidateLlmo(context);
    return ok(llmoConfig.customerIntent || []);
  };

  // Handles requests to the LLMO customer intent endpoint, adds new customer intent items
  const addLlmoCustomerIntent = async (context) => {
    const { log } = context;
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
  };

  // Handles requests to the LLMO customer intent endpoint, removes a customer intent item
  const removeLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;
    const { site, config } = await getSiteAndValidateLlmo(context);

    validateCustomerIntentKey(config, intentKey);

    // remove the customer intent using the config method
    config.removeLlmoCustomerIntent(intentKey);

    await saveSiteConfig(site, config, log, 'removing customer intent');

    // return the updated llmoConfig customer intent
    return ok(config.getLlmoConfig().customerIntent || []);
  };

  // Handles requests to the LLMO customer intent endpoint, updates a customer intent item
  const patchLlmoCustomerIntent = async (context) => {
    const { log } = context;
    const { intentKey } = context.params;
    const { data } = context;
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
  };
}

export default LlmoController;
