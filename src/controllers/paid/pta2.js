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
import {
  AWSAthenaClient, getPTASummaryWithTrendQuery, PTASummaryWithTrendResponseDto,
} from '@adobe/spacecat-shared-athena-client';
import crypto from 'crypto';
import AccessControlUtil from '../../support/access-control-util.js';

function getOutPrefix(query) {
  return crypto.createHash('md5').update(query).digest('hex');
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

function PTA2Controller(context, log, env) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

  const {
    RUM_METRICS_DATABASE: rumMetricsDatabase,
    RUM_METRICS_COMPACT_TABLE: rumMetricsCompactTable,
    S3_BUCKET_NAME: bucketName,
  } = env;

  // constants
  const ATHENA_TEMP_FOLDER = `s3://${bucketName}/rum-metrics-compact/temp/out`;

  async function getPTAWeeklySummary() {
    /* c8 ignore next 1 */
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
      year, week, month,
    } = context.data;

    const temporal = validateTemporalParams({ year, week, month });
    if (!temporal.ok) {
      return badRequest(temporal.error);
    }

    const { yearInt, weekInt, monthInt } = temporal.values;
    log.info(`WEEKLY-SUMMARY - yearInt: ${yearInt}, weekInt: ${weekInt}, monthInt: ${monthInt}`);

    const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;
    const description = `fetch PTA2 Weekly Summary data db: ${rumMetricsDatabase}| siteKey: ${siteId} | year: ${year} | month: ${month} | week: ${week} } `;
    log.info(`WEEKLY-SUMMARY - description: ${description}`);

    // build query
    const query = getPTASummaryWithTrendQuery({
      year: yearInt,
      week: weekInt,
      month: monthInt,
      siteId,
      tableName,
    });

    log.info(`WEEKLY-SUMMARY - query: ${query}`);

    const outPrefix = getOutPrefix(query);
    const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
    const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

    const results = await athenaClient.query(query, rumMetricsDatabase, description);
    const response = PTASummaryWithTrendResponseDto.toJSON(results);

    return ok(response, {
      'content-encoding': 'gzip',
    });
  }

  return {
    getPTAWeeklySummary,
  };
}

export default PTA2Controller;
