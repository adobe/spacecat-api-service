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
import { AWSAthenaClient } from '@adobe/spacecat-shared-athena-client';
import crypto from 'crypto';
import { getStaticContent } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../../support/access-control-util.js';
import { TrafficDataResponseDto } from '../../dto/traffic-data-base-response.js';
import { TrafficDataWithCWVDto } from '../../dto/traffic-data-response-with-cwv.js';
import {
  getS3CachedResult,
  addResultJsonToCache,
  fileExists,
} from './caching-helper.js';
import { getDateRanges } from '../../../test/controllers/paid/calendar-week-helper.js';

async function loadSql(variables) {
  return getStaticContent(variables, './src/controllers/paid/channel-query.sql.tpl');
}

function getWeekMonthsAndYears(year, week) {
  const ranges = getDateRanges(week, year);
  const months = [...new Set(ranges.map((r) => r.month))].join(', ');
  const years = [...new Set(ranges.map((r) => r.year))].join(', ');
  return { months, years };
}

function getCacheKey(siteId, query, cacheLocation) {
  const outPrefix = crypto.createHash('md5').update(query).digest('hex');
  const cacheKey = `${cacheLocation}/${siteId}/${outPrefix}.json`;
  return { cacheKey, outPrefix };
}

function TrafficController(context, log, env) {
  const { dataAccess, s3 } = context;
  const { Site } = dataAccess;

  const {
    RUM_METRICS_DATABASE: rumMetricsDatabase,
    RUM_METRICS_COMPACT_TABLE: rumMetricsCompactTable,
    S3_BUCKET_NAME: bucketName,
  } = env;

  // constants
  const ATHENA_TEMP_FOLDER = `s3://${bucketName}`;
  const CACHE_LOCATION = `s3://${bucketName}/cache`;

  async function tryGetCacheResult(siteId, query) {
    const { cacheKey, outPrefix } = getCacheKey(siteId, query, CACHE_LOCATION);
    if (await fileExists(s3, cacheKey, log)) {
      log.info(`Found cached result. Fetching signed URL for Athena result from S3: ${cacheKey}`);
      const cachedUrl = await getS3CachedResult(s3, cacheKey, log);
      return { cachedResultUrl: cachedUrl, cacheKey, outPrefix };
    }
    return { cachedResultUrl: null, cacheKey, outPrefix };
  }

  async function fetchPaidTrafficData(dimensions, mapper) {
    const siteId = context.params?.siteId;
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    // validate input params
    const { year, week } = context.data;
    if (!year || !week) {
      return badRequest('Year and week are required parameters');
    }

    const { months, years } = getWeekMonthsAndYears(year, week);
    const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;
    const groupBy = dimensions;
    const dimensionColumns = groupBy.join(', ');
    const dimensionColumnsPrefixed = `${groupBy.map((col) => `a.${col}`).join(', ')}, `;
    const description = `fetch paid channel data | db: ${rumMetricsDatabase} | siteKey: ${siteId} | year: ${year} | month: ${months} | week: ${week} | groupBy: [${groupBy.join(', ')}] | template: channel-query.sql.tpl`;

    log.info(`Processing query: ${description}`);

    // build query
    const query = await loadSql({
      siteId,
      years,
      months,
      week,
      groupBy: groupBy.join(', '),
      dimensionColumns,
      dimensionColumnsPrefixed,
      tableName,
    });

    log.debug(`Fetching paid data with query: ${query}`);

    // first try to get from cache
    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(siteId, query);
    const thresholdConfig = env.CWV_THRESHOLDS || {};
    if (cachedResultUrl) {
      log.info(`Successfully fetched presigned URL for cached result file: ${cacheKey}`);
      return found(cachedResultUrl);
    }

    // if not cached, query Athena
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    log.info(`Fetching paid data directly from Athena table: ${tableName}`);
    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const response = results.map((row) => mapper.toJSON(row, thresholdConfig));
    log.info(`Successfully fetched results of size ${response?.length}`);

    // add to cache
    let isCached = false;
    if (response) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Athena result JSON to S3 cache (${cacheKey}) successful: ${isCached}`);
    }

    // if cached, return pre-signed url, else return direct response
    if (isCached) {
      log.info(`Fetching signed URL from: ${cacheKey}`);
      const cachedUrl = await getS3CachedResult(s3, cacheKey, log);
      return found(cachedUrl);
    }

    log.error(`Failed to cache result to S3 with key ${CACHE_LOCATION}. Returning response directly.`);
    return ok(response);
  }

  return {
    getPaidTrafficByCampaignUrlDevice: () => fetchPaidTrafficData(['utm_campaign', 'path', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignDevice: () => fetchPaidTrafficData(['utm_campaign', 'device'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaignUrl: () => fetchPaidTrafficData(['utm_campaign', 'path'], TrafficDataWithCWVDto),
    getPaidTrafficByCampaign: () => fetchPaidTrafficData(['utm_campaign'], TrafficDataWithCWVDto),
    getPaidTrafficByTypeChannelCampaign: () => fetchPaidTrafficData(['trf_type', 'trf_channel', 'utm_campaign'], TrafficDataResponseDto),
    getPaidTrafficByTypeChannel: () => fetchPaidTrafficData(['trf_type', 'trf_channel'], TrafficDataResponseDto),
    getPaidTrafficByTypeCampaign: () => fetchPaidTrafficData(['trf_type', 'utm_campaign'], TrafficDataResponseDto),
    getPaidTrafficByType: () => fetchPaidTrafficData(['trf_type'], TrafficDataResponseDto),
  };
}

export default TrafficController;
