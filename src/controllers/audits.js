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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { getContentClient, publishToHelixAdmin } from '../support/utils.js';
import { AuditDto } from '../dto/audit.js';

/**
 * Audits controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Audits controller.
 * @constructor
 */
function AuditsController(dataAccess, env) {
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
    function mergeOverwrites(existingOverwrites, manualOverwrites) {
      const overrides = {};
      [...existingOverwrites, ...manualOverwrites].forEach((overwrite) => {
        overrides[overwrite.brokenTargetURL] = overwrite;
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

    const config = site.getConfig();
    const handlerConfig = config.getHandlerConfig(auditType);
    if (!handlerConfig) {
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
        : Array.from(new Set([...(config.getExcludedURLs(auditType) || []), ...excludedURLs]));

      config.updateExcludedURLs(auditType, newExcludedURLs);
    }

    if (Array.isArray(manualOverwrites)) {
      for (const manualOverwrite of manualOverwrites) {
        if (!isObject(manualOverwrite)) {
          return badRequest('Manual overwrite must be an object');
        }
        if (Object.keys(manualOverwrite).length === 0) {
          return badRequest('Manual overwrite object cannot be empty');
        }
        if (!hasText(manualOverwrite.brokenTargetURL) || !hasText(manualOverwrite.targetURL)) {
          return badRequest('Manual overwrite must have both brokenTargetURL and targetURL');
        }
        if (!isValidUrl(manualOverwrite.brokenTargetURL)
            || !isValidUrl(manualOverwrite.targetURL)) {
          return badRequest('Invalid URL format');
        }
      }

      hasUpdates = true;

      const existingOverwrites = config.getManualOverwrites(auditType);
      const newManualOverwrites = manualOverwrites.length === 0
        ? []
        : mergeOverwrites(existingOverwrites, manualOverwrites);

      config.updateManualOverwrites(auditType, newManualOverwrites);
    }
    if (hasUpdates) {
      const handlerType = config.getHandlerConfig(auditType);
      const configObj = Config.toDynamoItem(config);
      site.updateConfig(configObj);
      await dataAccess.updateSite(site);
      return ok(handlerType);
    }
    return badRequest('No updates provided');
  };

  const patchAuditFixesForSite = async (context) => {
    function mergeFixes(existing, changes) {
      const computedMerge = {};
      [...existing, ...changes].forEach((fix) => {
        computedMerge[fix.brokenTargetURL] = fix;
      });
      return Object.values(computedMerge);
    }
    const { log } = context;
    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType;
    const { fixedURLs } = context.data;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    if (!Array.isArray(fixedURLs)) {
      return badRequest('Fixed URL array required');
    }

    if (fixedURLs.length === 0) {
      return badRequest('Fixed URL array cannot be empty');
    }
    for (const fixedURL of fixedURLs) {
      if (!isObject(fixedURL)) {
        return badRequest('Fixed URL must be an object');
      }
      if (Object.keys(fixedURL).length === 0) {
        return badRequest('Fixed URL object cannot be empty');
      }
      if (!hasText(fixedURL.brokenTargetURL) || !hasText(fixedURL.targetURL)) {
        return badRequest('Fixed URL must have both brokenTargetURL and targetURL');
      }
      if (!isValidUrl(fixedURL.brokenTargetURL)
            || !isValidUrl(fixedURL.targetURL)) {
        return badRequest('Fixed URL have invalid URL format');
      }
    }
    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const config = site.getConfig();
    const handlerConfig = config.getHandlerConfig(auditType);
    if (!handlerConfig) {
      return notFound('Audit type not found');
    }
    const existingFixedURLs = config.getFixedURLs(auditType);
    const newFixedURLs = mergeFixes(existingFixedURLs, fixedURLs);
    const contentClient = await getContentClient(env, site, log);
    for (const { brokenTargetURL, targetURL } of fixedURLs) {
      // eslint-disable-next-line no-await-in-loop
      await contentClient.appendRowToSheet('/redirects.xlsx', 'Sheet1', [brokenTargetURL, targetURL]);
    }
    const hlxConfig = config.getHlxConfig();
    await publishToHelixAdmin(hlxConfig.rso.owner, hlxConfig.rso.site, hlxConfig.rso.ref, '/redirects.xlsx');
    config.updateFixedURLs(auditType, newFixedURLs);
    const configObj = Config.toDynamoItem(config);
    site.updateConfig(configObj);
    await dataAccess.updateSite(site);

    return ok(config.getFixedURLs(auditType));
  };

  return {
    getAllForSite,
    getAllLatest,
    getAllLatestForSite,
    getLatestForSite,
    patchAuditForSite,
    patchAuditFixesForSite,
  };
}

export default AuditsController;
