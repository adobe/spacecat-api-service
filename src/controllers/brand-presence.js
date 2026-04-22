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
      return unauthorized('Missing required scope: brand-presence.write');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }

      if (!data || !Array.isArray(data.metrics)) {
        return badRequest('Request body must contain a "metrics" array');
      }

      const { metrics } = data;
      const total = metrics.length;
      const ch = new ClickhouseClient({}, log);

      let written;
      let failures;

      try {
        ({ written, failures } = await ch.writeBatch(BRAND_PRESENCE_TABLE, metrics));
      } catch (err) {
        log.error(`[brand-presence-controller] ClickHouse write failed: ${err.message}`);
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
          log.error(`[brand-presence-controller] ClickHouse competitor write failed: ${err.message}`);
        } finally {
          await chComp.close();
        }
      }

      // Claude Code, Sonnet 4.6
      return createResponse({
        metadata: { total, success: written, failure: failures.length },
        failures,
        items: metrics.filter((_, index) => !failedIndexes.has(index)), // Claude Code, Sonnet 4.6
      }, 201);
    } catch (err) {
      log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics: ${err.message}`, err);
      return internalServerError('Internal server error');
    }
  };

  const queryData = async (requestContext) => {
    const { siteId } = requestContext.params;

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }

      return ok({ data: [] });
    } catch (err) {
      log.error(`[brand-presence-controller] GET /sites/${siteId}/brand-presence/data: ${err.message}`, err);
      return internalServerError('Internal server error');
    }
  };

  return { ingestMetrics, queryData };
}

export default BrandPresenceController;
