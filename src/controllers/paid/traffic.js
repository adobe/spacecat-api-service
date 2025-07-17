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

async function tryGetCacheResult(siteid, s3, cacheBucket, query, log, noCache = false) {
  const outPrefix = `${crypto.createHash('md5').update(query).digest('hex')}`;
  const cacheKey = `${cacheBucket}/${siteid}/${outPrefix}.json`;
  if (noCache === true) {
    log.info(`Skipping cache fetch for Athena result from S3: ${cacheKey} because user requested noCache`);
    return { cachedResultUrl: null, cacheKey, outPrefix };
  }
  const hasCache = await fileExists(s3, cacheKey, log);
  if (hasCache === true) {
    log.info(`Found cached result. Fetching signed url for cached Athena result from S3: ${cacheKey}`);
    const cached = await getS3CachedResult(s3, cacheKey, log);
    return { cachedResultUrl: cached, cacheKey, outPrefix };
  }
  return { cachedResultUrl: null, cacheKey, outPrefix };
}

function TrafficController(context, log, env) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

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

    const { year, week, noCache } = context.data;
    if (!year || !week) {
      const badReqMessagge = 'year and week are required parameters';
      log.info(badReqMessagge);
      return badRequest(badReqMessagge);
    }
    const { months, years } = getWeekMonthsAndYears(year, week);
    const dbName = env.PAID_TRAFFIC_DATABASE;
    const tableName = env.PAID_TRAFFIC_TABLE_NAME;
    const fullTableName = `${dbName}.${tableName}`;
    const groupBy = dimensions;
    const dimensionColumns = groupBy.join(', ');
    const dimensionColumnsPrefixed = `${groupBy.map((col) => `a.${col}`).join(', ')}, `;
    const description = `fetch paid channel data | db: ${dbName} | siteKey: ${siteId} | year: ${year} | month: ${months} | week: ${week} | groupBy: [${groupBy.join(', ')}] | template: channel-query.sql.tpl`;
    log.info(`Processing query: ${description}`);

    const query = await loadSql({
      siteId,
      years,
      months,
      week,
      groupBy: groupBy.join(', '),
      dimensionColumns,
      dimensionColumnsPrefixed,
      tableName: fullTableName,
    });

    log.debug(`Fetching paid data with query ${query}`);
    const outputFolder = env.PAID_TRAFFIC_S3_OUTPUT_URI || 's3://spacecat-dev-segments/temp/out';
    const cacheBucket = env.PAID_TRAFFIC_S3_CACHE_BUCKET_URI || 's3://spacecat-dev-segments/cache';
    const { s3 } = context;
    const {
      cachedResultUrl,
      cacheKey,
      outPrefix,
    } = await tryGetCacheResult(siteId, s3, cacheBucket, query, log, noCache);
    const thresholdConfig = env.CWV_THRESHOLDS || {};
    if (cachedResultUrl) {
      log.info(`Succesfully fetched presigned url for result file ${cacheKey} from cache`);
      return found(cachedResultUrl);
    }

    const resultLocation = `${outputFolder}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    log.info(`Fetching paid data directly from athena bucket ${outputFolder} and table ${fullTableName}`);
    const results = await athenaClient.query(
      query,
      dbName,
      description,
    );
    const response = results.map((row) => mapper.toJSON(row, thresholdConfig));
    log.info(`Succesfully fetched results of size ${response?.length}`);
    let isCached;
    if (response) {
      isCached = await addResultJsonToCache(s3, cacheKey, response, log);
      log.info(`Is Copy Athena result json to S3 cache: ${cacheKey} succesful was : ${isCached}`);
    }

    if (isCached) {
      log.info(`Fetching signed url from : ${cacheKey}`);
      const cachedUrl = await getS3CachedResult(s3, cacheKey, log);
      return found(cachedUrl);
    }
    log.error(`Failed to cache result to s3 with key ${cacheBucket}. Returning response directly.`);
    return ok(response);
  }

  const getPaidTrafficByCampaignUrlDevice = async () => fetchPaidTrafficData(['utm_campaign', 'path', 'device'], TrafficDataWithCWVDto);
  const getPaidTrafficByCampaignDevice = async () => fetchPaidTrafficData(['utm_campaign', 'device'], TrafficDataWithCWVDto);
  const getPaidTrafficByCampaignUrl = async () => fetchPaidTrafficData(['utm_campaign', 'path'], TrafficDataWithCWVDto);
  const getPaidTrafficByCampaign = async () => fetchPaidTrafficData(['utm_campaign'], TrafficDataWithCWVDto);
  const getPaidTrafficByTypeChannelCampaign = async () => fetchPaidTrafficData(['trf_type', 'trf_channel', 'utm_campaign'], TrafficDataResponseDto);
  const getPaidTrafficByTypeChannel = async () => fetchPaidTrafficData(['trf_type', 'trf_channel'], TrafficDataResponseDto);
  const getPaidTrafficByTypeCampaign = async () => fetchPaidTrafficData(['trf_type', 'utm_campaign'], TrafficDataResponseDto);
  const getPaidTrafficByType = async () => fetchPaidTrafficData(['trf_type'], TrafficDataResponseDto);

  return {
    getPaidTrafficByCampaignUrlDevice,
    getPaidTrafficByCampaignDevice,
    getPaidTrafficByCampaignUrl,
    getPaidTrafficByCampaign,
    getPaidTrafficByTypeChannelCampaign,
    getPaidTrafficByTypeChannel,
    getPaidTrafficByTypeCampaign,
    getPaidTrafficByType,
  };
}

export default TrafficController;
