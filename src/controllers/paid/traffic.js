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
} from '@adobe/spacecat-shared-http-utils';
import { AWSAthenaClient } from '@adobe/spacecat-shared-athena-client';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MarketingChannelResponseDto } from '../../dto/marketing-channel-response.js';
import AccessControlUtil from '../../support/access-control-util.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

let channelQueryTemplate = '';

// Load the SQL template at startup
(async () => {
  const templatePath = path.join(dirname, 'channel-query.sql.tpl');
  channelQueryTemplate = await fs.readFile(templatePath, 'utf-8');
})();

function renderQuery(template, params) {
  return template
    .replace(/{{siteId}}/g, params.siteKey)
    .replace(/{{year}}/g, params.year)
    .replace(/{{month}}/g, params.month)
    .replace(/{{week}}/g, params.week)
    .replace(/{{groupBy}}/g, params.groupBy)
    .replace(/{{dimensionColumns}}/g, params.dimensionColumns)
    .replace(/{{dimensionColumnsPrefixed}}/g, params.dimensionColumnsPrefixed)
    .replace(/{{tableName}}/g, params.tableName);
}

const VALID_DIMENSIONS = ['type', 'channel', 'campaign'];

function TrafficController(context, log, env) {
  if (!context || !context.dataAccess) {
    throw new Error('Context and dataAccess required');
  }
  const { dataAccess } = context;
  const { Site } = dataAccess;

  const getPaidTrafficDataByMarketingChannel = async () => {
    const siteId = context.params?.siteId;

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const accessControlUtil = AccessControlUtil.fromContext(context);

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    const dbName = env.PAID_TRAFFIC_DATABASE;
    const tableName = env.PAID_TRAFFIC_TABLE_NAME;
    if (!dbName || !tableName) {
      throw new Error('PAID_TRAFFIC_DATABASE and PAID_TRAFFIC_TABLE_NAME are requited');
    }
    const fullTableName = `${dbName}.${tableName}`;
    const resolvedS3Output = env.PAID_TRAFFIC_S3_OUTPUT;
    const athenaClient = AWSAthenaClient.fromContext(context, resolvedS3Output);
    const {
      siteKey, year, week, dimension, month,
    } = context.data || {};
    if (!siteId || !year || !week) {
      throw new Error('siteKey, year, and week are required parameters');
    }

    let groupBy;
    if (Array.isArray(dimension) && dimension.length > 0) {
      // Only allow valid dimensions
      groupBy = dimension.filter((d) => VALID_DIMENSIONS.includes(d));
      if (groupBy.length === 0) {
        throw new Error('At least one valid dimension (type, channel, campaign) must be specified');
      }
    } else {
      groupBy = VALID_DIMENSIONS;
    }
    const dimensionColumns = groupBy.join(', ');
    const dimensionColumnsPrefixed = groupBy.length > 0
      ? `${groupBy.map((col) => `a.${col}`).join(', ')}, `
      : '';
    const query = renderQuery(channelQueryTemplate, {
      siteKey,
      year,
      month,
      week,
      groupBy: groupBy.join(', '),
      dimensionColumns,
      dimensionColumnsPrefixed,
      tableName: fullTableName,
    });

    const description = `Fetch paid channel data | db: ${dbName} | siteKey: ${siteKey} | year: ${year} | month: ${month} | week: ${week} | groupBy: [${groupBy.join(', ')}] | template: channel-query.sql.tpl`;

    log.info(`Fetching Athena data with query ${query}`);

    const results = await athenaClient.query(
      query,
      dbName,
      description,
    );

    const resultJson = Array.isArray(results)
      ? results.map(MarketingChannelResponseDto.toJSON)
      : [];

    return ok(resultJson);
  };

  return {
    getPaidTrafficDataByMarketingChannel,
  };
}

export default TrafficController;
