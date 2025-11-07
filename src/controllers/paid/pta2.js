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
  AWSAthenaClient, getPTASummaryQuery, PTASummaryResponseDto,
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

const isTrue = (value) => value === true || value === 'true';

function PTA2Controller(context, log, env) {
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

  async function getPTAWeeklySummary() {
    /* c8 ignore next 1 */
    const requestId = context.invocation?.requestId;
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
    const {
      year, week, month, noCache,
    } = context.data;

    const temporal = validateTemporalParams({ year, week, month });
    if (!temporal.ok) {
      return badRequest(temporal.error);
    }

    const { yearInt, weekInt, monthInt } = temporal.values;

    const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;

    const description = `fetch PTA2 Weekly Summary data db: ${rumMetricsDatabase}| siteKey: ${siteId} | year: ${year} | month: ${month} | week: ${week} } `;

    // build query
    const query = getPTASummaryQuery({
      year: yearInt,
      week: weekInt,
      month: monthInt,
      siteId,
      tableName,
    });

    // first try to get from cache
    const { cachedResultUrl, cacheKey, outPrefix } = await tryGetCacheResult(
      siteId,
      query,
      noCache,
    );

    if (cachedResultUrl) {
      log.info(`Successfully fetched presigned URL for cached result file: ${cacheKey}. Request ID: ${requestId}`);
      return found(cachedResultUrl);
    }

    // if not cached, query Athena
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const response = results.map((row) => PTASummaryResponseDto.toJSON(row));

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

  return {
    getPTAWeeklySummary,
  };
}

export default PTA2Controller;
