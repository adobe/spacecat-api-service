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

import { parse } from 'tldts';
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
  static processData(filePath, data, queryParams) {
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

    processedData = this.extractData(filePath, processedData, 'https://adobe.com');
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
    url.searchParams.set('limit', '10000000');

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
      const processedData = LlmoQuerySpecificCache.processData(filePath, rawData, queryParams);
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

  /**
   * @private
   */
  static extractData(filePath, weekData, siteBaseUrl) {
    let allSheetRecords = [];
    let competitorsRecords = [];

    // filePath contains something like brandpresence-all-W45-2025.json
    // so build an object with the week and year from the filePath
    // but watch out, the filePath contains a lot of characters before
    // so do it with a regex
    const weekAndYear = filePath.match(/brandpresence-all-w(\d{2})-(\d{4})/);
    const week = weekAndYear[1];
    const year = weekAndYear[2];

    // Get week information from weekData
    const weekInfo = { week, year };
    const weekString = `${weekInfo.year}-W${weekInfo.week.toString().padStart(2, '0')}`;
    Object.entries(weekData).forEach(([sheetName, sheetContent]) => {
      // Extract from 'all' sheet
      if (sheetName.includes('all')) {
        const records = Array.isArray(sheetContent.data) ? sheetContent.data : [];

        // Enrich records in place so weekly trend calculations see the updated data
        records.forEach((record) => {
          // Add week information
          // eslint-disable-next-line no-param-reassign
          record.Week = weekString;
          // eslint-disable-next-line no-param-reassign
          record.week = weekString;

          // Parse sources field and create SourcesDetail
          const { Prompt: prompt } = record;
          if (prompt) {
            // Parse semicolon-separated URLs from sources field
            const sources = record.sources || record.Sources || '';
            const urls = LlmoQuerySpecificCache.parseSourcesUrls(sources);

            // Get competitor domains for content type determination
            const competitorDomains = LlmoQuerySpecificCache.extractCompetitorDomains(record);

            // Create citations for each URL
            const sourcesDetail = urls.map((url) => {
              const contentType = siteBaseUrl
                ? LlmoQuerySpecificCache.determineContentType(url, siteBaseUrl, competitorDomains)
                : 'earned';

              const brand = LlmoQuerySpecificCache.extractDomain(url) || '';

              return {
                url,
                brand,
                numTimesCited: 1, // Each occurrence counts as 1 citation
                contentType,
                week: weekString,
                weekNumber: weekInfo.week,
                year: weekInfo.year,
              };
            });

            // eslint-disable-next-line no-param-reassign
            record.SourcesDetail = sourcesDetail;

            // Set sources_contain_branddomain based on whether any source is 'owned'
            const hasOwnedSource = sourcesDetail.some((source) => source.contentType === 'owned');

            // Always set the field based on our analysis (modifying in place!)
            // eslint-disable-next-line no-param-reassign
            record.sources_contain_branddomain = hasOwnedSource ? 'true' : 'false';
            // eslint-disable-next-line no-param-reassign
            record['Sources Contain Brand Domain'] = hasOwnedSource ? 'true' : 'false';
          }
        });

        // Also collect them for the return value
        allSheetRecords = allSheetRecords.concat(records);
      }

      // Extract from 'brand_vs_competitors' sheet
      if (sheetName.includes('brand_vs_competitors')) {
        const records = Array.isArray(sheetContent.data) ? sheetContent.data : [];
        // Add week information to each record (modifying in place)
        records.forEach((record) => {
          // eslint-disable-next-line no-param-reassign
          record.Week = weekString;
          // eslint-disable-next-line no-param-reassign
          record.week = weekString;
        });
        competitorsRecords = competitorsRecords.concat(records);
      }
    });

    // eslint-disable-next-line no-param-reassign
    weekData.all.data = allSheetRecords;
    // eslint-disable-next-line no-param-reassign
    weekData.brand_vs_competitors.data = competitorsRecords;
    return weekData;
  }

  /**
   * @private
   */
  static parseSourcesUrls(sources) {
    if (!sources || typeof sources !== 'string') return [];

    return sources
      .split(';')
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
      .map((url) => LlmoQuerySpecificCache.normalizeUrl(url));
  }

  /**
   * @private
   */
  static extractCompetitorDomains(record) {
    const competitors = [];

    // Extract from Business Competitors field only (semicolon separated)
    if (record['Business Competitors'] || record.businessCompetitors) {
      const businessCompetitors = record['Business Competitors'] || record.businessCompetitors;
      if (typeof businessCompetitors === 'string') {
        competitors.push(...businessCompetitors.split(';').map((c) => c.trim()).filter((c) => c.length > 0));
      }
    }

    // Deduplicate
    return [...new Set(competitors)];
  }

  /**
   * @private
   */
  static determineContentType(url, siteBaseUrl, competitorNames) {
    // Priority 1: Check if owned
    if (LlmoQuerySpecificCache.isOwnedUrl(url, siteBaseUrl)) {
      return 'owned';
    }

    // Priority 2: Check if competitor/others
    if (competitorNames && LlmoQuerySpecificCache.isCompetitorUrl(url, competitorNames)) {
      return 'others';
    }

    // Priority 3: Check if social media
    if (LlmoQuerySpecificCache.isSocialMediaUrl(url)) {
      return 'social';
    }

    // Default: earned (third-party content)
    return 'earned';
  }

  /**
   * @private
   */
  static extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  static normalizeUrl(url) {
    if (!url || typeof url !== 'string') return url;

    let normalized = url.trim();

    // Check if this is a path (starts with /) or a full URL
    const isPath = normalized.startsWith('/');

    if (isPath) {
      // For paths, just strip query params with regex (preserve fragments)
      normalized = normalized.replace(/\?[^#]*/, '');
    } else {
      // For full URLs, use URL object for proper parsing
      try {
        const urlObj = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);

        // Clear all search params but keep hash/fragment
        urlObj.search = '';

        // Add www. to bare domains (not subdomains like helpx.adobe.com)
        const { subdomain } = parse(urlObj.hostname);
        if (!subdomain && !urlObj.hostname.startsWith('www.')) {
          urlObj.hostname = `www.${urlObj.hostname}`;
        }

        normalized = urlObj.toString();
      } catch {
        // If URL parsing fails, use fallback approach
        // Remove query params: everything between ? and # (or end of string if no #)
        normalized = normalized.replace(/\?[^#]*/, '');
      }
    }

    // Remove trailing slash, except for root paths
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Normalize protocol to lowercase (only for full URLs)
    if (!isPath) {
      if (normalized.startsWith('HTTP://')) {
        normalized = `http://${normalized.slice(7)}`;
      } else if (normalized.startsWith('HTTPS://')) {
        normalized = `https://${normalized.slice(8)}`;
      }
    }

    return normalized;
  }

  /**
   * @private
   */
  static isOwnedUrl(url, siteBaseUrl) {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const siteObj = new URL(siteBaseUrl);

      const urlHostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();
      const siteHostname = siteObj.hostname.replace(/^www\./, '').toLowerCase();

      // Check if URL hostname matches or is a subdomain of site hostname
      return urlHostname === siteHostname || urlHostname.endsWith(`.${siteHostname}`);
    } catch {
      return false;
    }
  }

  /**
   * @private
   */
  static isCompetitorUrl(url, competitorNames) {
    if (!competitorNames || competitorNames.length === 0) return false;

    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const urlHostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();

      // Check if any competitor name appears in the domain
      return competitorNames.some((competitorName) => {
        const nameLower = competitorName.toLowerCase().trim();
        return urlHostname.includes(nameLower);
      });
    } catch {
      return false;
    }
  }

  /**
   * @private
   */
  static isSocialMediaUrl(url) {
    const SOCIAL_MEDIA_DOMAINS = [
      'twitter.com',
      'x.com',
      'facebook.com',
      'linkedin.com',
      'instagram.com',
      'youtube.com',
      'tiktok.com',
      'reddit.com',
      'pinterest.com',
      'snapchat.com',
      'discord.com',
      'twitch.tv',
      'medium.com',
      'quora.com',
      'tumblr.com',
      'vimeo.com',
    ];

    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const hostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();
      return SOCIAL_MEDIA_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }
}
