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
import { SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import {
  applyFilters, applyInclusions, applySort, applyPagination,
} from './llmo-utils.js';

export default class LlmoQuerySpecificCache {
  constructor(getSiteAndValidateLlmo) {
    this.getSiteAndValidateLlmo = getSiteAndValidateLlmo;
  }

  /**
   * Generates a cache key that includes all query parameters
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  generateCacheKey(filePath, queryParams, llmoConfig) {
    const { dataFolder } = llmoConfig;

    // Sort query params to ensure consistent cache keys
    const sortedParams = {};
    Object.keys(queryParams)
      .sort()
      .forEach((key) => {
        sortedParams[key] = queryParams[key];
      });

    // Create a string representation of the query params
    const paramsString = JSON.stringify(sortedParams);

    // Combine dataFolder, filePath, and query params into a single cache key
    return `${dataFolder}/${filePath}:${paramsString}`;
  }

  /**
   * Processes data by applying filters and inclusions based on query parameters
   * @private
   */
  static processData(data, queryParams) {
    let processedData = data;

    // Apply sheet filtering if provided (e.g., ?sheets=sheet1,sheet2)
    if (queryParams.sheets && processedData[':type'] === 'multi-sheet') {
      const requestedSheets = Array.isArray(queryParams.sheets)
        ? queryParams.sheets
        : queryParams.sheets.split(',').map((sheet) => sheet.trim());

      // Create a new data object with only the requested sheets
      const filteredData = { ':type': 'multi-sheet' };
      requestedSheets.forEach((sheetName) => {
        if (processedData[sheetName]) {
          filteredData[sheetName] = processedData[sheetName];
        }
      });
      processedData = filteredData;
    }

    // Apply filters if provided (e.g., ?filter.status=active&filter.type=premium)
    const filterFields = {};
    Object.keys(queryParams).forEach((key) => {
      if (key.startsWith('filter.')) {
        const fieldName = key.substring(7); // Remove 'filter.' prefix
        filterFields[fieldName] = queryParams[key];
      }
    });

    if (Object.keys(filterFields).length > 0) {
      processedData = applyFilters(processedData, filterFields);
    }

    // Apply inclusions if provided (e.g., ?include=field1,field2,field3)
    if (queryParams.include) {
      const includeFields = Array.isArray(queryParams.include)
        ? queryParams.include
        : queryParams.include.split(',').map((field) => field.trim());
      processedData = applyInclusions(processedData, includeFields);
    }

    // Apply sorting if provided (e.g., ?sort=field:asc or ?sort=field:desc)
    if (queryParams.sort) {
      const sortParam = Array.isArray(queryParams.sort)
        ? queryParams.sort[0]
        : queryParams.sort;
      const [field, order = 'asc'] = sortParam.split(':').map((s) => s.trim());

      // Validate order is either 'asc' or 'desc'
      const sortOrder = order.toLowerCase() === 'desc' ? 'desc' : 'asc';

      processedData = applySort(processedData, { field, order: sortOrder });
    }

    // Apply pagination (limit and offset) as the final step
    // This ensures pagination is applied after all filtering and sorting
    if (queryParams.limit || queryParams.offset) {
      const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : undefined;
      const offset = queryParams.offset ? parseInt(queryParams.offset, 10) : 0;

      processedData = applyPagination(processedData, { limit, offset });
    }

    return processedData;
  }

  /**
   * Fetches and processes a single file with caching of the final result
   * @private
   */
  async fetchAndProcessSingleFile(context, filePath, queryParams, llmoConfig) {
    const { log, env, valkey } = context;
    const { sheet } = context.data;

    // Get cache from context (initialized by valkeyClientWrapper)
    const cache = valkey?.cache;

    // Generate cache key that includes all query parameters
    const cacheKey = this.generateCacheKey(filePath, { ...queryParams, sheet }, llmoConfig);

    // Try to get processed result from cache first
    const cacheStartTime = Date.now();
    const cachedResult = cache ? await cache.get(cacheKey) : null;
    const cacheFetchTime = Date.now() - cacheStartTime;

    if (cachedResult) {
      log.info(`✓ Processed result cache HIT for: ${cacheKey} (fetch time: ${cacheFetchTime}ms)`);
      return {
        data: cachedResult,
        headers: {},
      };
    }

    // Cache miss - fetch raw data and process it
    log.info(`✗ Processed result cache MISS for: ${cacheKey} (cache check time: ${cacheFetchTime}ms), fetching and processing`);

    const LLMO_SHEETDATA_SOURCE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';
    const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${llmoConfig.dataFolder}/${filePath}`);

    // Use a large limit to fetch all data from the source
    // Pagination will be applied after sorting and filtering
    url.searchParams.set('limit', '1000000');

    // allow fetching a specific sheet from the sheet data source
    if (sheet) {
      url.searchParams.set('sheet', sheet);
    }

    const urlAsString = url.toString();
    log.info(`Fetching single file with path: ${urlAsString}`);

    // Create an AbortController with a 60-second timeout for large data fetches
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds

    // Start timing the source fetch
    const sourceFetchStartTime = Date.now();

    try {
      // Fetch data from the external endpoint using the dataFolder from config
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
          'Accept-Encoding': 'br',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the raw response data
      const rawData = await response.json();
      const fetchTime = Date.now() - sourceFetchStartTime;

      log.info(`✓ Fetch from HELIX ${filePath}: ${fetchTime}ms`);

      // Process the data with all query parameters
      const processStartTime = Date.now();
      const processedData = LlmoQuerySpecificCache.processData(rawData, queryParams);
      const processTime = Date.now() - processStartTime;

      log.info(`✓ Data processing completed in ${processTime}ms`);

      // Cache the processed result (async, don't wait for it)
      if (cache) {
        cache.set(cacheKey, processedData).catch((error) => {
          log.error(`Failed to cache processed data for ${cacheKey}: ${error.message}`);
        });
      }

      return {
        data: processedData,
        headers: response.headers ? Object.fromEntries(response.headers.entries()) : {},
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        log.error(`Request timeout after 60000ms for file: ${filePath}`);
        throw new Error('Request timeout after 60000ms');
      }
      throw error;
    }
  }

  /**
   * Fetches and processes multiple files in parallel
   * @private
   */
  async fetchAndProcessMultipleFiles(context, files, queryParams, llmoConfig) {
    const { log } = context;

    // Fetch and process all files in parallel
    const fetchPromises = files.map(async (filePath) => {
      try {
        const { data } = await this.fetchAndProcessSingleFile(
          context,
          filePath,
          queryParams,
          llmoConfig,
        );
        return {
          path: filePath,
          status: 'success',
          data,
        };
      } catch (error) {
        log.error(`Error fetching and processing file ${filePath}: ${error.message}`);
        return {
          path: filePath,
          status: 'error',
          error: error.message,
        };
      }
    });

    // Wait for all parallel fetches to complete
    const results = await Promise.all(fetchPromises);

    return results;
  }

  async query(context) {
    const { log } = context;
    const {
      siteId, dataSource, sheetType, week,
    } = context.params;
    const { file, ...queryParams } = context.data;

    try {
      const { llmoConfig } = await this.getSiteAndValidateLlmo(context);

      // Multi-file mode: if 'file' query param exists
      if (file) {
        const files = Array.isArray(file) ? file : [file];
        log.info(`Fetching and processing multiple files for siteId: ${siteId}, files: ${files.join(', ')}`);

        const results = await this.fetchAndProcessMultipleFiles(
          context,
          files,
          queryParams,
          llmoConfig,
        );

        return ok({ files: results }, { 'Content-Encoding': 'br' });
      }

      // Single-file mode: construct the sheet URL based on path parameters
      let filePath;
      if (sheetType && week) {
        filePath = `${sheetType}/${week}/${dataSource}`;
      } else if (sheetType) {
        filePath = `${sheetType}/${dataSource}`;
      } else {
        filePath = dataSource;
      }

      log.info(`Fetching and processing single file for siteId: ${siteId}, path: ${filePath}`);
      const { data, headers } = await this.fetchAndProcessSingleFile(
        context,
        filePath,
        queryParams,
        llmoConfig,
      );

      // Return the processed data, pass through any compression headers from upstream
      return ok(data, headers);
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message}`);
      return badRequest(error.message);
    }
  }
}
