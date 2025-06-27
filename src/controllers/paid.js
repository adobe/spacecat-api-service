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
  badRequest,
  notFound,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import { isValidUUID, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';

const AUDIT_TYPE_PAID = 'paid';

/**
 * Paid Traffic Metrics controller.
 * @param {object} ctx - Context of the request.
 * @returns {object} Paid controller.
 * @constructor
 */
function PaidController(ctx) {
  if (!ctx || !ctx.dataAccess) {
    throw new Error('Context and dataAccess required');
  }
  const { dataAccess } = ctx;
  const { Site, LatestAudit } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets top pages by paid traffic for a site.
   * @param {object} context - Request context.
   * @returns {Promise<Response>} Top paid pages response.
   */
  const getTopPaidPages = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    // Fetch the latest audit for auditType 'paid'
    const audits = await LatestAudit.allBySiteIdAndAuditType(siteId, AUDIT_TYPE_PAID);
    if (!isNonEmptyArray(audits)) {
      return notFound('No data found for paid traffic metrics');
    }

    const latestAudit = audits[0].getAuditResult();
    const urlTrafficSource = latestAudit.find((r) => r.key === 'urlTrafficSource');
    let urlResults = [];
    if (urlTrafficSource && Array.isArray(urlTrafficSource.value)) {
      urlResults = urlTrafficSource.value;
    }

    if (!isNonEmptyArray(urlResults)) {
      return notFound('No url specific traffic data found for the site');
    }

    const topPages = urlResults.map((item) => ({
      url: item.url,
      ctr: item.ctr,
      avgClicksPerSession: item.avgClicksPerSession,
      pageViews: item.pageViews,
      clickedSessions: item.clickedSessions,
      bounceRate: item.bounceRate,
      totalNumClicks: item.totalNumClicks,
      source: item.source,
    }));

    return ok(topPages);
  };

  return {
    getTopPaidPages,
  };
}

export default PaidController;
