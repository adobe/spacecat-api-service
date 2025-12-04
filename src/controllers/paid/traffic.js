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
  ok,
  notFound,
  forbidden,
  badRequest,
  found,
} from '@adobe/spacecat-shared-http-utils';
import {
  AWSAthenaClient, TrafficDataResponseDto, getTrafficAnalysisQuery,
  TrafficDataWithCWVDto, getTrafficAnalysisQueryPlaceholdersFilled,
  getTop3PagesWithTrafficLostTemplate,
} from '@adobe/spacecat-shared-athena-client';
import crypto from 'crypto';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  getS3CachedResult,
  addResultJsonToCache,
  fileExists,
  getSignedUrlWithRetries,
} from './caching-helper.js';

function getCacheKey(siteId, query, cacheLocation, pageViewThreshold, filter = null) {
  const outPrefix = crypto.createHash('md5').update(`${query}_${pageViewThreshold}_${filter ? filter.filterKey : ''}`).digest('hex');
  const cacheKey = `${cacheLocation}/${siteId}/${outPrefix}.json`;
  return { cacheKey, outPrefix };
}

function validateTemporalParams({ year, week, month }) {
  // Helper to check if value is null or undefined
  const isNullish = (value) => value === undefined || value === null;

  // Helper to parse integer with validation
  const parseInteger = (value, name) => {
    if (isNullish(value)) return 0;

    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`${name} must be a valid number`);
    }
    return parsed;
  };

  try {
    // Year is required
    if (isNullish(year)) {
      return { ok: false, error: 'Year is a required parameter' };
    }

    // At least one of week or month must be provided
    if (isNullish(week) && isNullish(month)) {
      return { ok: false, error: 'Either week or month must be provided' };
    }

    // Parse all values
    const yearInt = parseInteger(year, 'Year');
    const weekInt = parseInteger(week, 'Week');
    const monthInt = parseInteger(month, 'Month');

    // At least one of week or month must be non-zero
    if (weekInt === 0 && monthInt === 0) {
      return { ok: false, error: 'Either week or month must be non-zero' };
    }

    return {
      ok: true,
      values: { yearInt, weekInt, monthInt },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const isTrue = (value) => value === true || value === 'true' || value === '1' || value === 1;

function TrafficController(context, log, env) {
  const { dataAccess, s3 } = context;
  const { Site } = dataAccess;

  const {
    RUM_METRICS_DATABASE: rumMetricsDatabase,
    RUM_METRICS_COMPACT_TABLE: rumMetricsCompactTable,
    S3_BUCKET_NAME: bucketName,
  } = env;

  // constants
  const ATHENA_TEMP_FOLDER = `s3://${bucketName}/rum-metrics-compact/temp/out`;
  const CACHE_LOCATION = `s3://${bucketName}/rum-metrics-compact/cache`;

  async function tryGetCacheResult(siteId, query, noCache, pageViewThreshold, filter = null) {
    const { cacheKey, outPrefix } = getCacheKey(
      siteId,
      query,
      CACHE_LOCATION,
      pageViewThreshold,
      filter,
    );
    if (isTrue(noCache)) {
      return { cachedResultUrl: null, cacheKey, outPrefix };
    }
    const maxAttempts = 1;
    if (await fileExists(s3, cacheKey, log, maxAttempts)) {
      const ignoreNotFound = true;
      const cachedUrl = await getS3CachedResult(s3, cacheKey, log, ignoreNotFound);
      return { cachedResultUrl: cachedUrl, cacheKey, outPrefix };
    }
    log.info(`Cached result for file: ${cacheKey} does not exist`);
    return { cachedResultUrl: null, cacheKey, outPrefix };
  }

  async function fetchPaidTrafficData(dimensions, mapper, filter = null, isWeekOverWeek = false) {
    /* c8 ignore next 1 */
    const requestId = context.invocation?.requestId;
    const siteId = context.params?.siteId;
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const baseURL = await site.getBaseURL();
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    // validate input params
    const {
      year, week, month, noCache, trafficType, noThreshold,
    } = context.data;

    const temporal = validateTemporalParams({ year, week, month });
    if (!temporal.ok) {
      return badRequest(temporal.error);
    }

    const disableThreshold = isTrue(noThreshold);

    const { yearInt, weekInt, monthInt } = temporal.values;

    const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;

    let pageTypes = null;
    if (dimensions.includes('page_type')) {
      pageTypes = await site.getPageTypes();
    }

    let trfTypes = null;
    if (trafficType && ['owned', 'earned', 'paid'].includes(trafficType)) {
      trfTypes = [trafficType];
    }

    // no filter supplied and api is not for traffic type default to paid
    if (trafficType == null && !dimensions.includes('trf_type')) {
      trfTypes = ['paid'];
    }
    let pageViewThreshold = env.PAID_DATA_THRESHOLD ?? 1000;
    if (disableThreshold) {
      pageViewThreshold = 0;
    }

    const quereyParams = getTrafficAnalysisQueryPlaceholdersFilled({
      week: weekInt,
      month: monthInt,
      year: yearInt,
      siteId,
      dimensions,
      tableName,
      pageTypes,
      pageTypeMatchColumn: 'path',
      trfTypes,
      pageViewThreshold,
      numTemporalSeries: isWeekOverWeek ? 4 : 1,
    });

    const description = `fetch paid channel data db: ${rumMetricsDatabase}| siteKey: ${siteId} | year: ${year} | month: ${month} | week: ${week} } | temporalCondition: ${quereyParams.temporalCondition} | groupBy: [${dimensions.join(', ')}] `;

    // build query
    const query = getTrafficAnalysisQuery(quereyParams);

    // first try to get from cache
    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(
      siteId,
      query,
      noCache,
      pageViewThreshold,
      filter,
    );
    let thresholdConfig = {};
    if (env.CWV_THRESHOLDS) {
      if (typeof env.CWV_THRESHOLDS === 'string') {
        try {
          thresholdConfig = JSON.parse(env.CWV_THRESHOLDS);
        } catch (e) {
          log.warn('Invalid CWV_THRESHOLDS JSON. Falling back to defaults.');
          thresholdConfig = {};
        }
      } else if (typeof env.CWV_THRESHOLDS === 'object') {
        thresholdConfig = env.CWV_THRESHOLDS;
      }
    }

    if (cachedResultUrl) {
      log.info(`Successfully fetched presigned URL for cached result file: ${cacheKey}. Request ID: ${requestId}`);
      return found(cachedResultUrl);
    }

    // if not cached, query Athena
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const filteredResults = filter?.filterFunction ? filter.filterFunction(results) : results;
    const response = filteredResults.map((row) => mapper.toJSON(row, thresholdConfig, baseURL));

    // add to cache
    let isCached = false;
    if (response && response.length > 0) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Athena result JSON to S3 cache (${cacheKey}) successful: ${isCached}`);
    }

    if (isCached) {
      // even though file is saved 503 are possible in short time window,
      // verifying file is reachable before returning
      const verifiedSignedUrl = await getSignedUrlWithRetries(s3, cacheKey, log, 5);
      if (verifiedSignedUrl != null) {
        log.debug(`Successfully verified file existence, returning signedUrl from key: ${isCached}.  Request ID: ${requestId}`);
        return found(
          verifiedSignedUrl,
        );
      }
    }

    log.warn(`Failed to return cache key ${cacheKey}. Returning response directly. Request ID: ${requestId}`);
    return ok(response, {
      'content-encoding': 'gzip',
    });
  }

  async function fetchTop3PagesTrafficData(dimensions, disableThreshold, limit) {
    /* c8 ignore next 1 */
    const requestId = context.invocation?.requestId;
    const siteId = context.params?.siteId;
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const baseURL = await site.getBaseURL();
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    // validate input params
    const {
      temporalCondition, noCache,
    } = context.data;

    const decodedTemporalCondition = decodeURIComponent(temporalCondition);

    if (!decodedTemporalCondition.includes('week')
      || !decodedTemporalCondition.includes('year')) {
      return badRequest('Invalid temporal condition');
    }
    if (decodedTemporalCondition.match(/week/g).length !== 4
      || decodedTemporalCondition.match(/year/g).length !== 4) {
      return badRequest('Invalid temporal condition');
    }

    const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;

    let pageViewThreshold = env.PAID_DATA_THRESHOLD ?? 1000;
    if (disableThreshold) {
      pageViewThreshold = 0;
    }

    const dimensionColumns = dimensions.join(', ');
    const dimensionColumnsPrefixed = dimensions.map((col) => `a.${col}`).join(', ');

    const query = getTop3PagesWithTrafficLostTemplate({
      siteId,
      tableName,
      temporalCondition: decodedTemporalCondition,
      dimensionColumns,
      groupBy: dimensionColumns,
      dimensionColumnsPrefixed,
      pageViewThreshold,
      limit,
    });

    log.info(`getTop3PagesWithTrafficLostTemplate Query: ${query}`);

    const description = `fetch top 3 pages traffic data db: ${rumMetricsDatabase}| siteKey: ${siteId} | temporalCondition: ${decodedTemporalCondition} | groupBy: [${dimensions.join(', ')}] `;

    // first try to get from cache
    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(
      siteId,
      query,
      noCache,
      pageViewThreshold,
      null,
    );
    let thresholdConfig = {};
    if (env.CWV_THRESHOLDS) {
      if (typeof env.CWV_THRESHOLDS === 'string') {
        try {
          thresholdConfig = JSON.parse(env.CWV_THRESHOLDS);
        } catch (e) {
          log.warn('Invalid CWV_THRESHOLDS JSON. Falling back to defaults.');
          thresholdConfig = {};
        }
      } else if (typeof env.CWV_THRESHOLDS === 'object') {
        thresholdConfig = env.CWV_THRESHOLDS;
      }
    }

    if (cachedResultUrl) {
      log.info(`Successfully fetched presigned URL for cached result file: ${cacheKey}. Request ID: ${requestId}`);
      return found(cachedResultUrl);
    }

    // if not cached, query Athena
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const response = results.map(
      (row) => TrafficDataWithCWVDto.toJSON(row, thresholdConfig, baseURL),
    );

    // add to cache
    let isCached = false;
    if (response && response.length > 0) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Athena result JSON to S3 cache (${cacheKey}) successful: ${isCached}`);
    }

    if (isCached) {
      // even though file is saved 503 are possible in short time window,
      // verifying file is reachable before returning
      const verifiedSignedUrl = await getSignedUrlWithRetries(s3, cacheKey, log, 5);
      if (verifiedSignedUrl != null) {
        log.debug(`Successfully verified file existence, returning signedUrl from key: ${isCached}.  Request ID: ${requestId}`);
        return found(
          verifiedSignedUrl,
        );
      }
    }

    log.warn(`Failed to return cache key ${cacheKey}. Returning response directly. Request ID: ${requestId}`);
    return ok(response, {
      'content-encoding': 'gzip',
    });
  }

  async function getPaidTrafficBySpecificPlatform(channel, withDevice = false) {
    const dimensions = ['trf_channel', 'trf_platform'];
    if (withDevice) {
      dimensions.push('device');
    }
    return fetchPaidTrafficData(
      dimensions,
      TrafficDataResponseDto,
      {
        filterKey: channel,
        filterFunction: (results) => results.filter((item) => item.trf_channel === channel),
      },
    );
  }

  async function fetchPaidTrafficDataTemporalSeries(dimensions) {
    return fetchPaidTrafficData(
      dimensions,
      TrafficDataWithCWVDto,
      null,
      true,
    );
  }

  return {
    getPaidTrafficByCampaignUrlDevice: async () => fetchPaidTrafficData(['utm_campaign', 'path', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignDevice: async () => fetchPaidTrafficData(['utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignUrl: async () => fetchPaidTrafficData(['utm_campaign', 'path'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaign: async () => fetchPaidTrafficData(['utm_campaign'], TrafficDataWithCWVDto),
    getPaidTrafficByTypeChannelCampaign: async () => fetchPaidTrafficData(['trf_type', 'trf_channel', 'utm_campaign'], TrafficDataResponseDto),
    getPaidTrafficByTypeChannel: async () => fetchPaidTrafficData(['trf_type', 'trf_channel'], TrafficDataResponseDto),
    getPaidTrafficByTypeCampaign: async () => fetchPaidTrafficData(['trf_type', 'utm_campaign'], TrafficDataResponseDto),
    getPaidTrafficByType: async () => fetchPaidTrafficData(['trf_type'], TrafficDataResponseDto),
    getPaidTrafficByUrlPageTypePlatformCampaignDevice: async () => fetchPaidTrafficData(['path', 'page_type', 'trf_platform', 'utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypePlatformCampaignDevice: async () => fetchPaidTrafficData(['page_type', 'trf_platform', 'utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypeCampaignDevice: async () => fetchPaidTrafficData(['path', 'page_type', 'utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypeDevice: async () => fetchPaidTrafficData(['path', 'page_type', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypeCampaign: async () => fetchPaidTrafficData(['path', 'page_type', 'utm_campaign'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypePlatform: async () => fetchPaidTrafficData(['path', 'page_type', 'trf_platform'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypeCampaignPlatform: async () => fetchPaidTrafficData(['path', 'page_type', 'utm_campaign', 'trf_platform'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageTypePlatformDevice: async () => fetchPaidTrafficData(['path', 'page_type', 'trf_platform', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByPageType: async () => fetchPaidTrafficData(['page_type'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypeCampaignDevice: async () => fetchPaidTrafficData(['page_type', 'utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypeDevice: async () => fetchPaidTrafficData(['page_type', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypeCampaign: async () => fetchPaidTrafficData(['page_type', 'utm_campaign'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypePlatform: async () => fetchPaidTrafficData(['page_type', 'trf_platform'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypePlatformDevice: async () => fetchPaidTrafficData(['page_type', 'trf_platform', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByPageTypePlatformCampaign: async () => fetchPaidTrafficData(['page_type', 'trf_platform', 'utm_campaign'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlPageType: async () => fetchPaidTrafficData(['path', 'page_type'], TrafficDataWithCWVDto),
    // new PTA2 endpoints
    getPaidTrafficByTypeDevice: async () => fetchPaidTrafficData(['trf_type', 'device'], TrafficDataResponseDto),
    getPaidTrafficByTypeDeviceChannel: async () => fetchPaidTrafficData(['trf_type', 'device', 'trf_channel'], TrafficDataResponseDto),
    getPaidTrafficByChannel: async () => fetchPaidTrafficData(['trf_channel'], TrafficDataResponseDto),
    getPaidTrafficByChannelDevice: async () => fetchPaidTrafficData(['trf_channel', 'device'], TrafficDataResponseDto),
    getPaidTrafficByChannelPlatformDevice: async () => fetchPaidTrafficData(['trf_channel', 'trf_platform', 'device'], TrafficDataResponseDto),

    getPaidTrafficBySocialPlatform: async () => getPaidTrafficBySpecificPlatform('social'),
    getPaidTrafficBySocialPlatformDevice: async () => getPaidTrafficBySpecificPlatform('social', true),
    getPaidTrafficBySearchPlatform: async () => getPaidTrafficBySpecificPlatform('search'),
    getPaidTrafficBySearchPlatformDevice: async () => getPaidTrafficBySpecificPlatform('search', true),
    getPaidTrafficByDisplayPlatform: async () => getPaidTrafficBySpecificPlatform('display'),
    getPaidTrafficByDisplayPlatformDevice: async () => getPaidTrafficBySpecificPlatform('display', true),
    getPaidTrafficByVideoPlatform: async () => getPaidTrafficBySpecificPlatform('video'),
    getPaidTrafficByVideoPlatformDevice: async () => getPaidTrafficBySpecificPlatform('video', true),

    // Page Performance endpoints
    getPaidTrafficByUrl: async () => fetchPaidTrafficData(['path'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlChannel: async () => fetchPaidTrafficData(['path', 'trf_channel'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlChannelDevice: async () => fetchPaidTrafficData(['path', 'trf_channel', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByUrlChannelPlatformDevice: async () => fetchPaidTrafficData(['path', 'trf_channel', 'trf_platform', 'device'], TrafficDataWithCWVDto),

    // Campaign Performance endpoints
    // getPaidTrafficByCampaign (see above)
    getPaidTrafficByCampaignChannelDevice: async () => fetchPaidTrafficData(['utm_campaign', 'trf_channel', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignChannelPlatform: async () => fetchPaidTrafficData(['utm_campaign', 'trf_channel', 'trf_platform'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignChannelPlatformDevice: async () => fetchPaidTrafficData(['utm_campaign', 'trf_channel', 'trf_platform', 'device'], TrafficDataWithCWVDto),

    getPaidTrafficTemporalSeries: async () => fetchPaidTrafficDataTemporalSeries([]),
    getPaidTrafficTemporalSeriesByCampaign: async () => fetchPaidTrafficDataTemporalSeries(['utm_campaign']),
    getPaidTrafficTemporalSeriesByChannel: async () => fetchPaidTrafficDataTemporalSeries(['trf_channel']),
    getPaidTrafficTemporalSeriesByPlatform: async () => fetchPaidTrafficDataTemporalSeries(['trf_platform']),
    getPaidTrafficTemporalSeriesByCampaignChannel: async () => fetchPaidTrafficDataTemporalSeries(['utm_campaign', 'trf_channel']),
    getPaidTrafficTemporalSeriesByCampaignPlatform: async () => fetchPaidTrafficDataTemporalSeries(['utm_campaign', 'trf_platform']),
    getPaidTrafficTemporalSeriesByCampaignChannelPlatform: async () => fetchPaidTrafficDataTemporalSeries(['utm_campaign', 'trf_channel', 'trf_platform']),
    getPaidTrafficTemporalSeriesByChannelPlatform: async () => fetchPaidTrafficDataTemporalSeries(['trf_channel', 'trf_platform']),

    getPaidTrafficTemporalSeriesByUrl: async () => fetchPaidTrafficDataTemporalSeries(['path']),
    getPaidTrafficTemporalSeriesByUrlChannel: async () => fetchPaidTrafficDataTemporalSeries(['path', 'trf_channel']),
    getPaidTrafficTemporalSeriesByUrlPlatform: async () => fetchPaidTrafficDataTemporalSeries(['path', 'trf_platform']),
    getPaidTrafficTemporalSeriesByUrlChannelPlatform: async () => fetchPaidTrafficDataTemporalSeries(['path', 'trf_channel', 'trf_platform']),

    getTrafficLossByDevices: async () => fetchTop3PagesTrafficData(['device'], true, null),
    getImpactByPage: async () => fetchTop3PagesTrafficData(['path'], true, 3),
    getImpactByPageDevice: async () => fetchTop3PagesTrafficData(['path', 'device'], true, null),
    getImpactByPageTrafficTypeDevice: async () => fetchTop3PagesTrafficData(['path', 'trf_type', 'device'], true, null),
  };
}

export default TrafficController;
