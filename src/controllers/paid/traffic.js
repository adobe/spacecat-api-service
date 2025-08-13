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
} from '@adobe/spacecat-shared-athena-client';
import crypto from 'crypto';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  getS3CachedResult,
  addResultJsonToCache,
  fileExists,
  getSignedUrlWithRetries,
} from './caching-helper.js';

function getCacheKey(siteId, query, cacheLocation) {
  const outPrefix = crypto.createHash('md5').update(query).digest('hex');
  const cacheKey = `${cacheLocation}/${siteId}/${outPrefix}.json`;
  return { cacheKey, outPrefix };
}

const isTrue = (value) => value === true || value === 'true';

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

  async function tryGetCacheResult(siteId, query, noCache) {
    const { cacheKey, outPrefix } = getCacheKey(siteId, query, CACHE_LOCATION);
    if (isTrue(noCache)) {
      log.info(`Skipping cache check for file: ${cacheKey} because param noCache is: ${noCache}`);
      return { cachedResultUrl: null, cacheKey, outPrefix };
    }
    const maxAttempts = 1;
    if (await fileExists(s3, cacheKey, log, maxAttempts)) {
      log.info(`Found cached result. Fetching signed URL for Athena result from S3: ${cacheKey}`);
      const ignoreNotFound = true;
      const cachedUrl = await getS3CachedResult(s3, cacheKey, log, ignoreNotFound);
      return { cachedResultUrl: cachedUrl, cacheKey, outPrefix };
    }
    log.info(`Cached result for file: ${cacheKey} does not exist`);
    return { cachedResultUrl: null, cacheKey, outPrefix };
  }

  async function fetchPaidTrafficData(dimensions, mapper) {
    /* c8 ignore next 1 */
    const requestId = context.invocation?.requestId;
    log.info(`Fetching paid traffic data for the request: ${requestId}`);

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
      year, week, noCache, trafficType,
    } = context.data;
    if (!year || !week) {
      return badRequest('Year and week are required parameters');
    }

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

    const quereyParams = getTrafficAnalysisQueryPlaceholdersFilled({
      week,
      year,
      siteId,
      dimensions,
      tableName,
      pageTypes,
      pageTypeMatchColumn: 'path',
      trfTypes,
    });

    const description = `fetch paid channel data db: ${rumMetricsDatabase}| siteKey: ${siteId} | year: ${year} | week: ${week} } | temporalCondition: ${quereyParams.temporalCondition} | groupBy: [${dimensions.join(', ')}] `;

    log.info(`Processing query: ${description}`);

    // build query
    const query = getTrafficAnalysisQuery(quereyParams);

    log.debug(`Fetching paid data with query: ${query}`);

    // first try to get from cache
    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(
      siteId,
      query,
      noCache,
    );
    const thresholdConfig = env.CWV_THRESHOLDS || {};
    if (cachedResultUrl) {
      log.info(`Successfully fetched presigned URL for cached result file: ${cacheKey}. Request ID: ${requestId}`);
      return found(cachedResultUrl);
    }

    // if not cached, query Athena
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    log.info(`Fetching paid data directly from Athena table: ${tableName}`);
    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const response = results.map((row) => mapper.toJSON(row, thresholdConfig, baseURL));
    log.info(`Successfully fetched results of length ${response?.length}`);

    // add to cache
    let isCached = false;
    if (response) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Athena result JSON to S3 cache (${cacheKey}) successful: ${isCached}`);
    }

    if (isCached) {
      // even though file is saved 503 are possible in short time window,
      // verifying file is reachable before returning
      const verifiedSignedUrl = await getSignedUrlWithRetries(s3, cacheKey, log, 5);
      if (verifiedSignedUrl != null) {
        log.info(`Succesfully verified file existance, returning signedUrl from key: ${isCached}.  Request ID: ${requestId}`);
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

  };
}

export default TrafficController;
