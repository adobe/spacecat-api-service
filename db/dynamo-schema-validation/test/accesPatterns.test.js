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
const {
  getSiteByBaseURLWithAudits,
  getSiteByBaseURL,
  getSitesWithLatestAudit,
  getSiteByBaseURLWithLatestAudit,
  getSitesToAudit,
} = require('../src/accessPatterns.js');

const TOTAL_SITES = 100;
const AUDITS_PER_TYPE = 5;
const AUDIT_TYPES = ['lhs', 'cwv'];
const NUM_AUDITS_PER_TYPE_EXPECTED = TOTAL_SITES - (TOTAL_SITES / 10);

function checkSite(site, latestOnly = false) {
  expect(site.audits).toBeInstanceOf(Array);
  expect(site.createdAt).toBeDefined();
  expect(site.updatedAt).toBeDefined();
  if (latestOnly) {
    expect(site.audits).toHaveLength(1);
    const latestAudit = site.audits[0];
    expect(latestAudit.auditType).toBe('lhs');
    expect(latestAudit.siteId).toBe(site.id);
    expect(latestAudit.GSI1PK).toBe('ALL_LATEST_AUDITS');
    expect(latestAudit.GSI1SK).toBeDefined();
    expect(latestAudit.SK).toBeDefined();
    expect(latestAudit.fullAuditRef).toBeDefined();
    expect(latestAudit.expiresAt).toBeDefined();
  }
}

function checkSites(sites, latestOnly = false) {
  expect(sites).toBeInstanceOf(Array);
  expect(sites).toHaveLength(NUM_AUDITS_PER_TYPE_EXPECTED);

  sites.forEach((site) => {
    checkSite(site, latestOnly);
  });
}

describe('DynamoDB Access Patterns Tests', () => {
  test('getSiteByBaseURLWithAudits', async () => {
    const baseUrl = 'https://example1.com';
    const siteWithAudits = await getSiteByBaseURLWithAudits(baseUrl);

    expect(siteWithAudits).toBeDefined();
    expect(siteWithAudits.baseURL).toBe(baseUrl);
    expect(siteWithAudits.audits).toBeInstanceOf(Array);
    expect(siteWithAudits.audits).toHaveLength(AUDITS_PER_TYPE * AUDIT_TYPES.length);
  });

  test('getSiteByBaseURLWithAuditsOfType', async () => {
    const baseUrl = 'https://example1.com';
    const siteWithAudits = await getSiteByBaseURLWithAudits(baseUrl, 'lhs');

    expect(siteWithAudits).toBeDefined();
    expect(siteWithAudits.baseURL).toBe(baseUrl);
    expect(siteWithAudits.audits).toBeInstanceOf(Array);
    expect(siteWithAudits.audits).toHaveLength(AUDITS_PER_TYPE);
  });

  test('getSiteByBaseURL', async () => {
    const baseUrl = 'https://example1.com';
    const site = await getSiteByBaseURL(baseUrl);

    expect(site).toBeDefined();
    expect(site.baseURL).toBe(baseUrl);
    expect(site.id).toBeDefined();
    expect(site.imsOrgId).toBe('1-1234@AdobeOrg');
  });

  test('getSitesWithLatestAudit with audits in ascending order', async () => {
    const sites = await getSitesWithLatestAudit('lhs');

    checkSites(sites, true);

    // Check if audits are sorted in ascending order based on GSI1SK
    let lastGSI1SK = sites[0].audits[0].GSI1SK;
    sites.forEach((site) => {
      const currentGSI1SK = site.audits[0].GSI1SK;
      expect(currentGSI1SK.localeCompare(lastGSI1SK)).toBeGreaterThanOrEqual(0);
      lastGSI1SK = currentGSI1SK;
    });
  });

  test('getSitesWithLatestAudit with audits in descending order', async () => {
    const sites = await getSitesWithLatestAudit('lhs', false);

    checkSites(sites, true);

    // Check if audits are sorted in descending order based on GSI1SK
    let lastGSI1SK = sites[0].audits[0].GSI1SK;
    sites.forEach((site) => {
      const currentGSI1SK = site.audits[0].GSI1SK;
      expect(currentGSI1SK.localeCompare(lastGSI1SK)).toBeLessThanOrEqual(0);
      lastGSI1SK = currentGSI1SK;
    });
  });

  test('getSiteByBaseURLWithLatestAudit', async () => {
    const baseUrl = 'https://example1.com';
    const site = await getSiteByBaseURLWithLatestAudit(baseUrl, 'lhs');

    checkSite(site);
  });

  test('getSitesToAudit', async () => {
    const sites = await getSitesToAudit();

    expect(sites).toBeInstanceOf(Array);
    expect(sites).toHaveLength(TOTAL_SITES);

    // Verify that all expected base URLs are present
    const expectedBaseURLs = Array.from({ length: TOTAL_SITES }, (_, i) => `https://example${i}.com`);
    expectedBaseURLs.forEach((expectedUrl) => {
      expect(sites).toContain(expectedUrl);
    });
  });
});
