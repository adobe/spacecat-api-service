/*
 * Copyright 2023 Adobe. All rights reserved.
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
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import AuditConfigType from '@adobe/spacecat-shared-data-access/src/models/site/audit-config-type.js';

import { AuditDto } from '../dto/audit.js';

/**
 * Audits controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Audits controller.
 * @constructor
 */
function AuditsController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  /**
   * Gets all audits for a given site and audit type. If no audit type is specified,
   * all audits are returned.
   *
   * @returns {Promise<Response>} Array of audits response.
   */
  const getAllForSite = async (context) => {
    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType || undefined;
    const ascending = context.data?.ascending === 'true' || false;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const audits = (await dataAccess.getAuditsForSite(siteId, auditType, ascending))
      .map((audit) => AuditDto.toAbbreviatedJSON(audit));

    return ok(audits);
  };

  /**
   * Gets all audits for a given site and audit type. Sorts by auditedAt descending.
   * If the url parameter ascending is set to true, sorts by auditedAt ascending.
   *
   * @returns {Promise<Response>} Array of audits response.
   */
  const getAllLatest = async (context) => {
    const auditType = context.params?.auditType;
    const ascending = context.data?.ascending === 'true' || false;

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    const audits = (await dataAccess.getLatestAudits(auditType, ascending))
      .map((audit) => AuditDto.toAbbreviatedJSON(audit));

    return ok(audits);
  };

  /**
   * Gets all latest audits for a given site.
   * @returns {Promise<Response>} Array of audits response.
   */
  const getAllLatestForSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const audits = (await dataAccess.getLatestAuditsForSite(siteId))
      .map((audit) => AuditDto.toJSON(audit));

    return ok(audits);
  };

  /**
   * Gets all latest audits for a given site.
   * @returns {Promise<Response>} Array of audits response.
   */
  const getLatestForSite = async (context) => {
    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    const audit = await dataAccess.getLatestAuditForSite(siteId, auditType);
    if (!audit) {
      return notFound('Audit not found');
    }

    return ok(AuditDto.toJSON(audit));
  };

  /**
   * Update configuration for a site's audit
   * @returns {Promise<Response>} the site's updated audit config
   */
  const patchAuditForSite = async (context) => {
    function mergeOverrides(existingOverrides, manualOverwrites) {
      const overrides = {};
      [...existingOverrides, ...manualOverwrites].forEach((override) => {
        overrides[override.brokenTargetURL] = override;
      });
      return Object.values(overrides);
    }

    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    const { excludedURLs, manualOverwrites } = context.data;
    let hasUpdates = false;

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const auditConfig = site.getAuditConfig();
    const auditTypeConfig = auditConfig.getAuditTypeConfig(auditType);
    if (!auditTypeConfig) {
      return notFound('Audit type not found');
    }
    if (Array.isArray(excludedURLs)) {
      for (const url of excludedURLs) {
        if (!isValidUrl(url)) {
          return badRequest('Invalid URL format');
        }
      }

      hasUpdates = true;

      const newExcludedURLs = excludedURLs.length === 0
        ? []
        : Array.from(new Set([...(auditTypeConfig.getExcludedURLs() || []), ...excludedURLs]));

      auditTypeConfig.updateExcludedURLs(newExcludedURLs);
    }

    if (Array.isArray(manualOverwrites)) {
      for (const manualOverwrite of manualOverwrites) {
        if (!isValidUrl(manualOverwrite.brokenTargetURL)
            || !isValidUrl(manualOverwrite.targetURL)) {
          return badRequest('Invalid URL format');
        }
      }

      hasUpdates = true;

      const existingOverrides = auditTypeConfig.getManualOverwrites();
      const newManualOverwrites = manualOverwrites.length === 0
        ? []
        : mergeOverrides(existingOverrides, manualOverwrites);

      auditTypeConfig.updateManualOverwrites(newManualOverwrites);
    }
    if (hasUpdates) {
      const obj = AuditConfigType.toDynamoItem(auditTypeConfig);
      site.updateAuditTypeConfig(auditType, obj);
      await dataAccess.updateSite(site);

      return ok(obj);
    }
    return badRequest('No updates provided');
  };

  return {
    getAllForSite,
    getAllLatest,
    getAllLatestForSite,
    getLatestForSite,
    patchAuditForSite,
  };
}

export default AuditsController;
