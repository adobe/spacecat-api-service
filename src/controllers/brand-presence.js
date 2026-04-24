/*
 * Copyright 2026 Adobe. All rights reserved.
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
  badRequest,
  notFound,
  ok,
  createResponse,
  internalServerError,
  unauthorized,
} from '@adobe/spacecat-shared-http-utils';
import ClickhouseClient, { toBrandPresenceCompetitorData } from '@adobe/spacecat-shared-clickhouse-client';

const BRAND_PRESENCE_TABLE = 'brand_presence_executions';
const SCOPE_WRITE = 'brand-presence.write';

function BrandPresenceController(context) {
  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const ingestMetrics = async (requestContext) => {
    const { siteId } = requestContext.params;
    const { data, auth } = requestContext;

    try {
      auth.checkScopes([SCOPE_WRITE]);
    } catch {
      log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 401 Unauthorized: missing scope ${SCOPE_WRITE}`);
      return unauthorized('Missing required scope: brand-presence.write');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 404 Not Found: site does not exist`);
        return notFound(`Site not found: ${siteId}`);
      }

      if (!data || !Array.isArray(data.metrics)) {
        log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 400 Bad Request: "metrics" array is missing or invalid`);
        return badRequest('Request body must contain a "metrics" array');
      }

      const { metrics } = data;

      const invalidMetric = metrics.find(
        (m) => typeof m.visibility_score === 'number'
          && (m.visibility_score < 0 || m.visibility_score > 100),
      );
      if (invalidMetric) {
        log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 400 Bad Request: field "visibility_score" must be between 0 and 100, received: ${invalidMetric.visibility_score}`);
        return badRequest(`Invalid field: visibility_score must be between 0 and 100 (got ${invalidMetric.visibility_score})`);
      }

      const total = metrics.length;
      const ch = new ClickhouseClient({}, log);

      let written;
      let failures;

      try {
        ({ written, failures } = await ch.writeBatch(BRAND_PRESENCE_TABLE, metrics));
      } catch (err) {
        log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 500 ClickHouse write failed: ${err.constructor.name}: ${err.message}`);
        return internalServerError('Database write failed');
      } finally {
        await ch.close();
      }

      const failedIndexes = new Set(failures.map((f) => f.index));

      const competitorRows = metrics
        .filter((_, index) => !failedIndexes.has(index))
        .flatMap(toBrandPresenceCompetitorData);

      if (competitorRows.length > 0) {
        const chComp = new ClickhouseClient({}, log);
        try {
          await chComp.writeBatch('brand_presence_competitor_data', competitorRows);
        } catch (err) {
          log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — competitor write failed: ${err.constructor.name}: ${err.message}`);
        } finally {
          await chComp.close();
        }
      }

      const weeks = [...new Set(metrics.map((m) => m.week))].sort();
      const weekRange = weeks.length <= 1 ? (weeks[0] ?? 'none') : `${weeks[0]}..${weeks[weeks.length - 1]}`;
      log.info(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 201 Created: ${written}/${total} records written, ${failures.length} failed, weeks: ${weekRange}`);

      return createResponse({
        metadata: { total, success: written, failure: failures.length },
        failures,
        items: metrics.filter((_, index) => !failedIndexes.has(index)),
      }, 201);
    } catch (err) {
      log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics — 500 Internal Server Error: ${err.constructor.name}: ${err.message}`, err);
      return internalServerError('Internal server error');
    }
  };

  const queryData = async (requestContext) => {
    const { siteId } = requestContext.params;

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 404 Not Found: site does not exist`);
        return notFound(`Site not found: ${siteId}`);
      }

      const {
        start_week: startWeek = null,
        end_week: endWeek = null,
        platform = null,
        limit: rawLimit = '1000',
        offset: rawOffset = '0',
      } = requestContext.data || {};
      const limit = parseInt(rawLimit, 10);
      const offset = parseInt(rawOffset, 10);

      if (startWeek && !/^\d{4}-W\d{2}$/.test(startWeek)) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 400 Bad Request: invalid start_week format: ${startWeek}`);
        return badRequest('Invalid start_week format. Use YYYY-Www (e.g. 2025-W01)');
      }
      if (endWeek && !/^\d{4}-W\d{2}$/.test(endWeek)) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 400 Bad Request: invalid end_week format: ${endWeek}`);
        return badRequest('Invalid end_week format. Use YYYY-Www (e.g. 2025-W52)');
      }
      if (startWeek && endWeek && startWeek > endWeek) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 400 Bad Request: start_week ${startWeek} is after end_week ${endWeek}`);
        return badRequest('start_week must be before or equal to end_week');
      }
      if (Number.isNaN(limit) || limit < 1) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 400 Bad Request: invalid limit: ${rawLimit}`);
        return badRequest('limit must be a positive integer');
      }
      if (Number.isNaN(offset) || offset < 0) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 400 Bad Request: invalid offset: ${rawOffset}`);
        return badRequest('offset must be a non-negative integer');
      }

      const whereClause = ['site_id = {siteId:String}'];
      const queryParams = { siteId, limit, offset };

      if (startWeek) {
        whereClause.push('week >= {startWeek:String}');
        queryParams.startWeek = startWeek;
      }
      if (endWeek) {
        whereClause.push('week <= {endWeek:String}');
        queryParams.endWeek = endWeek;
      }
      if (platform && platform !== 'all') {
        whereClause.push('platform = {platform:String}');
        queryParams.platform = platform;
      }

      const where = whereClause.join(' AND ');
      const ch = new ClickhouseClient({}, log);

      let total;
      let rows;
      try {
        const countResult = await ch.query(
          `SELECT count() AS total FROM ${BRAND_PRESENCE_TABLE} WHERE ${where}`,
          queryParams,
        );
        total = parseInt(countResult[0]?.total ?? '0', 10);

        rows = await ch.query(
          `SELECT * FROM ${BRAND_PRESENCE_TABLE} WHERE ${where} ORDER BY (site_id, platform, execution_date, category, topic, prompt) LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
          queryParams,
        );
      } catch (err) {
        log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 500 ClickHouse query failed: ${err.constructor.name}: ${err.message}`);
        return internalServerError('Database query failed');
      } finally {
        await ch.close();
      }

      log.info(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 200 OK: ${rows.length}/${total} records returned, start_week: ${startWeek ?? 'none'}, end_week: ${endWeek ?? 'none'}, limit: ${limit}, offset: ${offset}`);

      return ok({ metadata: { total, limit, offset }, data: rows });
    } catch (err) {
      log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data — 500 Internal Server Error: ${err.constructor.name}: ${err.message}`, err);
      return internalServerError('Internal server error');
    }
  };

  return { ingestMetrics, queryData };
}

export default BrandPresenceController;
