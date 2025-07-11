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
} from '@adobe/spacecat-shared-http-utils';
import crypto from 'crypto';
import AccessControlUtil from '../../support/access-control-util.js';
import { MarketingChannelResponseDto } from '../../dto/marketing-channel-response.js';
import { QueryRegistry } from './query-registry.js';
import {
  parseCsvToJson,
  getS3CachedResult,
  copyFirstCsvToCache,
} from './caching-helper.js';

const queryRegistry = new QueryRegistry();

queryRegistry.loadTemplate();

async function tryGetCacheResult(siteid, s3, cacheBucket, query, log) {
  const outPrefix = `${crypto.createHash('md5').update(query).digest('hex')}`;
  const cacheKey = `${cacheBucket}/${siteid}/${outPrefix}.csv`;
  const cached = await getS3CachedResult(s3, cacheKey, log);
  if (cached) {
    log.info(`Found cached result. Returning cached Athena result from S3: ${cacheKey}`);
    const parsed = await parseCsvToJson(cached);
    const resultJson = parsed.map(MarketingChannelResponseDto.toJSON);
    return { resultJson, cacheKey, outPrefix };
  }
  return { resultJson: null, cacheKey, outPrefix };
}

function TrafficController(context, log, env) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

  async function fetchPaidTrafficData(dimensions) {
    const siteId = context.params?.siteId;
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    const {
      siteKey, year, week, month,
    } = context.data;
    if (!siteKey || !year || !week || !month) {
      const badReqMessagge = 'siteKey, year, month and week are required parameters';
      log.info(badReqMessagge);
      return badRequest(badReqMessagge);
    }
    const dbName = env.PAID_TRAFFIC_DATABASE || 'cdn_logs_wknd_site';
    const tableName = env.PAID_TRAFFIC_TABLE_NAME || 'rum_segments_data';
    const fullTableName = `${dbName}.${tableName}`;
    const groupBy = dimensions;
    const dimensionColumns = groupBy.join(', ');
    const dimensionColumnsPrefixed = `${groupBy.map((col) => `a.${col}`).join(', ')}, `;
    const description = `fetch paid channel data | db: ${dbName} | siteKey: ${siteKey} | year: ${year} | month: ${month} | week: ${week} | groupBy: [${groupBy.join(', ')}] | template: channel-query.sql.tpl`;
    log.info(`Processing query: ${description}`);

    const query = await queryRegistry.renderQuery({
      siteKey,
      year,
      month,
      week,
      groupBy: groupBy.join(', '),
      dimensionColumns,
      dimensionColumnsPrefixed,
      tableName: fullTableName,
    });

    log.debug(`Fetching paid data with query ${query}`);
    const outputFolder = env.PAID_TRAFFIC_S3_OUTPUT_URI || 's3://spacecat-dev-segments/temp/out';
    const cacheBucket = env.PAID_TRAFFIC_S3_CACHE_BUCKET_URI || 's3://spacecat-dev-segments/cache';
    const s3 = context.s3?.s3Client;
    const {
      resultJson,
      cacheKey,
      outPrefix,
    } = await tryGetCacheResult(siteId, s3, cacheBucket, query, log);
    if (resultJson) {
      return ok(resultJson);
    }

    const resultLocation = `${outputFolder}/${outPrefix}`;
    const athenaClient = context.athenaClientFactory(resultLocation);

    log.info(`Fetching paid data directly from athena bucket ${outputFolder} and table ${fullTableName}`);
    const results = await athenaClient.query(
      query,
      dbName,
      description,
    );

    const resultJsonFresh = results.map(MarketingChannelResponseDto.toJSON);

    if (resultJsonFresh) {
      const isCached = await copyFirstCsvToCache(s3, resultLocation, cacheKey, log);
      log.info(`Is Copy Athena result CSV to S3 cache: ${cacheKey} succesful was : ${isCached}`);
    }
    return ok(resultJsonFresh);
  }

  const getPaidTrafficByTypeChannelCampaign = async () => fetchPaidTrafficData(['type', 'channel', 'campaign']);
  const getPaidTrafficByTypeChannel = async () => fetchPaidTrafficData(['type', 'channel']);
  const getPaidTrafficByTypeCampaign = async () => fetchPaidTrafficData(['type', 'campaign']);
  const getPaidTrafficByType = async () => fetchPaidTrafficData(['type']);

  return {
    getPaidTrafficByTypeChannelCampaign,
    getPaidTrafficByTypeChannel,
    getPaidTrafficByTypeCampaign,
    getPaidTrafficByType,
  };
}

export default TrafficController;
