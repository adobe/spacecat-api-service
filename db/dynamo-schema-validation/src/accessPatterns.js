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
const { queryDb } = require('./db.js');

/**
 * Retrieves audits for a specified site. If an audit type is provided,
 * it returns only audits of that type.
 *
 * @param {string} siteId - The ID of the site for which audits are being retrieved.
 * @param {string} [auditType] - Optional. The type of audits to retrieve.
 * @returns {Promise<Array>} A promise that resolves to an array of audits for the specified site.
 */
async function getAuditsForSite(siteId, auditType) {
  // Base query parameters
  const queryParams = {
    TableName: 'audits',
    KeyConditionExpression: 'siteId = :siteId',
    ExpressionAttributeValues: {
      ':siteId': siteId,
    },
  };

  if (auditType !== undefined) {
    queryParams.KeyConditionExpression += ' AND begins_with(SK, :auditType)';
    queryParams.ExpressionAttributeValues[':auditType'] = `${auditType}#`;
  }

  return queryDb(queryParams);
}

/**
 * Retrieves the latest audit for a specified site and audit type.
 *
 * @param {string} siteId - The ID of the site for which the latest audit is being retrieved.
 * @param {string} auditType - The type of audit to retrieve the latest instance of.
 * @returns {Promise<Object|null>} A promise that resolves to the latest audit of the
 * specified type for the site, or null if none is found.
 */
async function getLatestAuditForSite(siteId, auditType) {
  const latestAudit = await queryDb({
    TableName: 'latest_audits',
    IndexName: 'latest_audit_scores',
    KeyConditionExpression: 'siteId = :siteId AND begins_with(GSI1SK, :auditType)',
    ExpressionAttributeValues: {
      ':siteId': siteId,
      ':auditType': `${auditType}#`,
    },
    Limit: 1,
  });

  return latestAudit.length > 0 ? latestAudit[0] : null;
}

/**
 * Retrieves a site by its base URL.
 *
 * @param {string} baseUrl - The base URL of the site to retrieve.
 * @returns {Promise<Object|null>} A promise that resolves to the site object if found,
 * otherwise null.
 */
async function getSiteByBaseURL(baseUrl) {
  const sites = await queryDb({
    TableName: 'sites',
    IndexName: 'sites_all', // Replace with your GSI name
    KeyConditionExpression: 'GSI1PK = :gsi1pk AND baseURL = :baseUrl',
    ExpressionAttributeValues: {
      ':gsi1pk': 'ALL_SITES',
      ':baseUrl': baseUrl,
    },
    Limit: 1,
  });

  return sites.length ? sites[0] : null;
}

/**
 * Retrieves a site by its base URL, along with associated audit information.
 *
 * @param {string} baseUrl - The base URL of the site to retrieve.
 * @param {string} auditType - The type of audits to retrieve for the site.
 * @param {boolean} [latestOnly=false] - Determines if only the latest audit should be retrieved.
 * @returns {Promise<Object|null>} A promise that resolves to the site object with audit
 * data if found, otherwise null.
 */
async function getSiteByBaseURLWithAuditInfo(baseUrl, auditType, latestOnly = false) {
  const site = await getSiteByBaseURL(baseUrl);

  if (!site) {
    return null;
  }

  if (latestOnly) {
    site.latestAudit = await getLatestAuditForSite(site.id, auditType);
  } else {
    site.audits = await getAuditsForSite(site.id, auditType);
  }

  return site;
}

/**
 * Retrieves a site by its base URL, including all its audits.
 *
 * @param {string} baseUrl - The base URL of the site to retrieve.
 * @param {string} auditType - The type of audits to retrieve for the site.
 * @returns {Promise<Object|null>} A promise that resolves to the site object with all its audits.
 */
async function getSiteByBaseURLWithAudits(baseUrl, auditType) {
  return getSiteByBaseURLWithAuditInfo(baseUrl, auditType, false);
}

/**
 * Retrieves a site by its base URL, including only its latest audit.
 *
 * @param {string} baseUrl - The base URL of the site to retrieve.
 * @param {string} auditType - The type of the latest audit to retrieve for the site.
 * @returns {Promise<Object|null>} A promise that resolves to the site object with its latest audit.
 */
async function getSiteByBaseURLWithLatestAudit(baseUrl, auditType) {
  return getSiteByBaseURLWithAuditInfo(baseUrl, auditType, true);
}

/**
 * Retrieves all sites.
 *
 * @returns {Promise<Array>} A promise that resolves to an array of all sites.
 */
async function getSites() {
  return queryDb({
    TableName: 'sites',
    IndexName: 'sites_all', // GSI name
    KeyConditionExpression: 'GSI1PK = :gsi1pk',
    ExpressionAttributeValues: {
      ':gsi1pk': 'ALL_SITES',
    },
  });
}

/**
 * Retrieves the latest audits of a specific type across all sites.
 *
 * @param {string} auditType - The type of audits to retrieve.
 * @returns {Promise<Array>} A promise that resolves to an array of the latest
 * audits of the specified type.
 */
async function getLatestAudits(auditType) {
  return queryDb({
    TableName: 'latest_audits',
    IndexName: 'latest_audits_all',
    KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :auditType)',
    ExpressionAttributeValues: {
      ':gsi1pk': 'ALL_LATEST_AUDITS',
      ':auditType': `${auditType}#`,
    },
    ScanIndexForward: false, // Audits already sorted in descending order by GSK1SK
  });
}

/**
 * Retrieves sites with their latest audit of a specified type.
 *
 * @param {string} auditType - The type of the latest audits to retrieve for each site.
 * @returns {Promise<Array>} A promise that resolves to an array of site objects,
 * each with its latest audit of the specified type.
 */
async function getSitesWithLatestAudit(auditType) {
  const [sites, latestAudits] = await Promise.all([
    getSites(),
    getLatestAudits(auditType),
  ]);

  const sitesMap = new Map(sites.map((site) => [site.id, site]));

  return latestAudits.reduce((result, audit) => {
    const site = sitesMap.get(audit.siteId);
    if (site) {
      result.push({
        ...site,
        latestAudit: audit,
      });
    }
    return result;
  }, []);
}

/**
 * Retrieves a list of base URLs for all sites.
 *
 * @returns {Promise<Array<string>>} A promise that resolves to an array of base URLs for all sites.
 */
async function getSitesToAudit() {
  const sites = await getSites();

  return sites.map((item) => item.baseURL);
}

module.exports = {
  getAuditsForSite,
  getLatestAudits,
  getSiteByBaseURL,
  getSiteByBaseURLWithAudits,
  getSiteByBaseURLWithLatestAudit,
  getSitesToAudit,
  getSitesWithLatestAudit,
};
