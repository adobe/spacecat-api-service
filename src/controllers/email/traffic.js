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
} from '../paid/caching-helper.js';

const EMAIL_TRF_TYPES = ['owned'];
const EMAIL_UTM_MEDIUM = 'email';
const DEFAULT_EMAIL_PAGEVIEW_THRESHOLD = 500;

function getCacheKey(siteId, query, cacheLocation, pageViewThreshold, filter = null) {
  const outPrefix = crypto.createHash('md5').update(`${query}_${pageViewThreshold}_${filter ? filter.filterKey : ''}`).digest('hex');
  const cacheKey = `${cacheLocation}/${siteId}/${outPrefix}.json`;
  return { cacheKey, outPrefix };
}

function validateTemporalParams({ year, week, month }) {
  const isNullish = (value) => value === undefined || value === null;

  const parseInteger = (value, name) => {
    if (isNullish(value)) {
      return 0;
    }

    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`${name} must be a valid number`);
    }
    return parsed;
  };

  try {
    if (isNullish(year)) {
      return { ok: false, error: 'Year is a required parameter' };
    }

    if (isNullish(week) && isNullish(month)) {
      return { ok: false, error: 'Either week or month must be provided' };
    }

    const yearInt = parseInteger(year, 'Year');
    const weekInt = parseInteger(week, 'Week');
    const monthInt = parseInteger(month, 'Month');

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

function EmailTrafficController(context, log, env) {
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

  async function fetchEmailTrafficData(dimensions, mapper, filter = null, isWeekOverWeek = false) {
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
      return forbidden('Only users belonging to the organization can view email traffic metrics');
    }

    // validate input params
    const {
      year, week, month, noCache, noThreshold,
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

    let pageViewThreshold = env.EMAIL_DATA_THRESHOLD ?? DEFAULT_EMAIL_PAGEVIEW_THRESHOLD;
    if (disableThreshold) {
      pageViewThreshold = 0;
    }

    if (isWeekOverWeek) {
      log.info(`Email week over week parameters: context.data: ${JSON.stringify(context.data)} / temporal: ${JSON.stringify(temporal)} / pageViewThreshold: ${pageViewThreshold}`);
    }

    const queryParams = getTrafficAnalysisQueryPlaceholdersFilled({
      week: weekInt,
      month: monthInt,
      year: yearInt,
      siteId,
      dimensions,
      tableName,
      pageTypes,
      pageTypeMatchColumn: 'path',
      trfTypes: EMAIL_TRF_TYPES,
      pageViewThreshold,
      numTemporalSeries: isWeekOverWeek ? 4 : 1,
    });

    if (isWeekOverWeek) {
      log.info(`Email week over week: queryParams: ${JSON.stringify(queryParams)}`);
    }

    const description = `fetch email traffic data db: ${rumMetricsDatabase}| siteKey: ${siteId} | year: ${year} | month: ${month} | week: ${week} } | temporalCondition: ${queryParams.temporalCondition} | groupBy: [${dimensions.join(', ')}] `;

    // build query
    const query = getTrafficAnalysisQuery(queryParams);

    log.info(`Site '${siteId}'/${year}/${month}/${week} getEmailTrafficAnalysisQuery Query: ${query}`);

    // first try to get from cache
    const emailFilter = {
      filterKey: `email_${filter ? filter.filterKey : ''}`,
      filterFunction: (results) => {
        // First apply utm_medium=email filter
        const emailFiltered = results.filter(
          (item) => item.utm_medium === EMAIL_UTM_MEDIUM,
        );
        // Then apply any additional filter
        return filter?.filterFunction ? filter.filterFunction(emailFiltered) : emailFiltered;
      },
    };

    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(
      siteId,
      query,
      noCache,
      pageViewThreshold,
      emailFilter,
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
    const filteredResults = emailFilter.filterFunction(results);
    const response = filteredResults.map((row) => mapper.toJSON(row, thresholdConfig, baseURL));

    // add to cache
    let isCached = false;
    if (response && response.length > 0) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Athena result JSON to S3 cache (${cacheKey}) successful: ${isCached}`);
    }

    if (isCached) {
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

  async function fetchEmailTrafficDataTemporalSeries(dimensions) {
    return fetchEmailTrafficData(
      dimensions,
      TrafficDataWithCWVDto,
      null,
      true,
    );
  }

  return {
    // Campaign-centric
    getEmailTrafficByCampaign: async () => fetchEmailTrafficData(['utm_campaign'], TrafficDataWithCWVDto),
    getEmailTrafficByCampaignDevice: async () => fetchEmailTrafficData(['utm_campaign', 'device'], TrafficDataWithCWVDto),
    getEmailTrafficByCampaignPath: async () => fetchEmailTrafficData(['utm_campaign', 'path'], TrafficDataWithCWVDto),
    getEmailTrafficByCampaignPathDevice: async () => fetchEmailTrafficData(['utm_campaign', 'path', 'device'], TrafficDataWithCWVDto),
    getEmailTrafficByCampaignPageType: async () => fetchEmailTrafficData(['utm_campaign', 'page_type'], TrafficDataWithCWVDto),
    getEmailTrafficByCampaignPageTypeDevice: async () => fetchEmailTrafficData(['utm_campaign', 'page_type', 'device'], TrafficDataWithCWVDto),

    // Source-centric (ESP identification)
    getEmailTrafficBySource: async () => fetchEmailTrafficData(['utm_source'], TrafficDataResponseDto),
    getEmailTrafficBySourceCampaign: async () => fetchEmailTrafficData(['utm_source', 'utm_campaign'], TrafficDataResponseDto),

    // Landing page-centric
    getEmailTrafficByUrl: async () => fetchEmailTrafficData(['path'], TrafficDataWithCWVDto),
    getEmailTrafficByUrlDevice: async () => fetchEmailTrafficData(['path', 'device'], TrafficDataWithCWVDto),
    getEmailTrafficByUrlPageType: async () => fetchEmailTrafficData(['path', 'page_type'], TrafficDataWithCWVDto),
    getEmailTrafficByUrlPageTypeDevice: async () => fetchEmailTrafficData(['path', 'page_type', 'device'], TrafficDataWithCWVDto),

    // Page type
    getEmailTrafficByPageType: async () => fetchEmailTrafficData(['page_type'], TrafficDataWithCWVDto),
    getEmailTrafficByPageTypeDevice: async () => fetchEmailTrafficData(['page_type', 'device'], TrafficDataWithCWVDto),

    // Device
    getEmailTrafficByDevice: async () => fetchEmailTrafficData(['device'], TrafficDataResponseDto),

    // Temporal series (week-over-week, 4 series)
    getEmailTrafficTemporalSeriesByCampaign: async () => fetchEmailTrafficDataTemporalSeries(['utm_campaign']),
    getEmailTrafficTemporalSeriesByCampaignDevice: async () => fetchEmailTrafficDataTemporalSeries(['utm_campaign', 'device']),
    getEmailTrafficTemporalSeriesByUrl: async () => fetchEmailTrafficDataTemporalSeries(['path']),
    getEmailTrafficTemporalSeriesByUrlDevice: async () => fetchEmailTrafficDataTemporalSeries(['path', 'device']),
    getEmailTrafficTemporalSeriesBySource: async () => fetchEmailTrafficDataTemporalSeries(['utm_source']),
    getEmailTrafficTemporalSeriesByDevice: async () => fetchEmailTrafficDataTemporalSeries(['device']),
  };
}

export default EmailTrafficController;
