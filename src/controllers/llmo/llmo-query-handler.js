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
  applyFilters,
  applyInclusions,
  applySort,
  LLMO_SHEETDATA_SOURCE_URL,
} from './llmo-utils.js';
import { fetchLlmoSource } from './llmo-source.js';

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

const fetchAndProcessSingleFile = async (context, llmoConfig, filePath, queryParams) => {
  const { log } = context;
  const { sheet } = context.data;

  const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${llmoConfig.dataFolder}/${filePath}`);

  // Apply pagination parameters when calling the source URL
  const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : 10000000;
  const offset = queryParams.offset ? parseInt(queryParams.offset, 10) : 0;

  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());

  // allow fetching a specific sheet from the sheet data source
  if (sheet) {
    url.searchParams.set('sheet', sheet);
  }

  const urlAsString = url.toString();
  log.info(`Fetching single file with path: ${urlAsString}`);

  const result = await fetchLlmoSource(context, urlAsString);
  if (result.noData) {
    return { noData: true };
  }

  const processedData = processData(result.data, queryParams);
  return { data: processedData, headers: result.headers };
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
        const single = await fetchAndProcessSingleFile(
          context,
          llmoConfig,
          filePath,
          queryParams,
        );
        if (single.noData) {
          return { path: filePath, status: 'no_data' };
        }
        return { path: filePath, status: 'success', data: single.data };
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
