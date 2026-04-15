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

import { SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import {
  applyFilters,
  applyInclusions,
  applySort,
  LLMO_SHEETDATA_SOURCE_URL,
} from './llmo-utils.js';

/**
 * Error thrown when the upstream Helix/EDS API returns a non-OK response.
 * Carries the upstream HTTP status so callers can map it to an appropriate response.
 */
export class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UpstreamError';
    this.upstreamStatus = status;
  }
}

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 1;

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const processData = (data, queryParams) => {
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

  // Apply filters if provided (e.g., ?filter.status=active&filter.category=category1)
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

  return processedData;
};

const TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 100000;

/**
 * Perform a single fetch attempt against the Helix/EDS backend.
 * Returns the Response object (caller checks .ok).
 */
const fetchFromHelix = async (url, env, signal) => fetch(url.toString(), {
  headers: {
    Authorization: `token ${env.LLMO_HLX_API_KEY}`,
    'User-Agent': SPACECAT_USER_AGENT,
    'Accept-Encoding': 'br',
  },
  signal,
});

const fetchAndProcessSingleFile = async (context, llmoConfig, filePath, queryParams) => {
  const { log, env } = context;
  const { sheet } = context.data;

  const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${llmoConfig.dataFolder}/${filePath}`);

  // Apply pagination parameters when calling the source URL.
  // Cap at DEFAULT_LIMIT to prevent oversized responses that overwhelm Helix.
  const parsedLimit = queryParams.limit ? parseInt(queryParams.limit, 10) : DEFAULT_LIMIT;
  const limit = Math.min(parsedLimit, DEFAULT_LIMIT);
  const offset = queryParams.offset ? parseInt(queryParams.offset, 10) : 0;

  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());

  // allow fetching a specific sheet from the sheet data source
  if (sheet) {
    url.searchParams.set('sheet', sheet);
  }

  log.info(`Fetching single file with path: ${url.toString()}`);

  // Validate API key exists before making the request
  if (!env.LLMO_HLX_API_KEY) {
    throw new Error('LLMO_HLX_API_KEY environment variable is not configured');
  }

  // Each attempt gets its own AbortController with a fresh timeout
  // so retries are not starved by time consumed by the first attempt.
  let controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Start timing the source fetch
  const sourceFetchStartTime = Date.now();

  try {
    let response = await fetchFromHelix(url, env, controller.signal);

    // Retry once on 503 (Helix transiently overloaded)
    if (response.status === 503 && MAX_RETRIES > 0) {
      clearTimeout(timeoutId);
      log.info(`Helix returned 503 for ${filePath}, retrying after ${RETRY_DELAY_MS}ms`);
      await delay(RETRY_DELAY_MS);
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      response = await fetchFromHelix(url, env, controller.signal);
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
      throw new UpstreamError(
        response.status,
        `External API returned ${response.status}: ${response.statusText}`,
      );
    }

    // Get the raw response data
    const rawData = await response.json();
    const fetchTime = Date.now() - sourceFetchStartTime;

    log.info(`✓ Fetch from HELIX ${filePath}: ${fetchTime}ms`);

    // Process the data with all query parameters
    const processStartTime = Date.now();
    const processedData = processData(rawData, queryParams);
    const processTime = Date.now() - processStartTime;

    log.info(`✓ Data processing completed in ${processTime}ms`);

    return {
      data: processedData,
      headers: response.headers ? Object.fromEntries(response.headers.entries()) : {},
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      log.debug(`Request timeout after ${TIMEOUT_MS}ms for file: ${filePath}`);
      throw new UpstreamError(504, `Request timeout after ${TIMEOUT_MS}ms`);
    }
    throw error;
  }
};

/**
 * Process promises in batches with controlled concurrency
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to process each item
 * @param {number} concurrency - Maximum number of concurrent operations
 * @returns {Promise<Array>} - Results array
 */
const processBatch = async (items, fn, concurrency) => {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = fn(item).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
};

const fetchAndProcessMultipleFiles = async (context, llmoConfig, files, queryParams) => {
  const { log } = context;

  // Limit concurrent fetches to prevent resource contention and timeouts
  // This prevents all requests from competing for bandwidth/resources
  const MAX_CONCURRENT_FETCHES = 7;

  log.info(`Fetching ${files.length} files with max concurrency of ${MAX_CONCURRENT_FETCHES}`);

  // Fetch and process files with controlled concurrency
  const results = await processBatch(
    files,
    async (filePath) => {
      try {
        const { data } = await fetchAndProcessSingleFile(
          context,
          llmoConfig,
          filePath,
          queryParams,
        );
        return {
          path: filePath,
          status: 'success',
          data,
        };
      } catch (error) {
        log.debug(`Error fetching and processing file ${filePath}: ${error.message}`);
        return {
          path: filePath,
          status: 'error',
          error: error.message,
        };
      }
    },
    MAX_CONCURRENT_FETCHES,
  );

  return results;
};

export const queryLlmoFiles = async (context, llmoConfig) => {
  const { log } = context;
  const {
    siteId, dataSource, sheetType, week,
  } = context.params;
  const { file, ...queryParams } = context.data;

  // Single-file mode: prioritize path parameters if dataSource is present
  if (dataSource) {
    let filePath;
    if (sheetType && week) {
      filePath = `${sheetType}/${week}/${dataSource}`;
    } else if (sheetType) {
      filePath = `${sheetType}/${dataSource}`;
    } else {
      filePath = dataSource;
    }

    log.info(`Fetching and processing single file for siteId: ${siteId}, path: ${filePath}`);
    return fetchAndProcessSingleFile(
      context,
      llmoConfig,
      filePath,
      queryParams,
    );
  }

  // Multi-file mode: fallback to 'file' query param if no path parameters
  if (file) {
    const files = Array.isArray(file) ? file : [file];
    log.info(`Fetching and processing multiple files for siteId: ${siteId}, files: ${files.join(', ')}`);

    const results = await fetchAndProcessMultipleFiles(
      context,
      llmoConfig,
      files,
      queryParams,
    );

    return { data: results, headers: { 'Content-Encoding': 'br' } };
  }

  // If neither path parameters nor file query param exist, throw an error
  throw new Error('Either dataSource path parameter or file query parameter must be provided');
};
