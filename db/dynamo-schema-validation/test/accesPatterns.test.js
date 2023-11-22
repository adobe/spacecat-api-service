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

describe('DynamoDB Access Patterns Tests', () => {
  test('getSiteByBaseURLWithAudits', async () => {
    const baseUrl = 'https://example1.com'; // Use an existing baseURL for testing
    const siteWithAudits = await getSiteByBaseURLWithAudits(baseUrl);

    expect(siteWithAudits).not.toBeNull();
    expect(siteWithAudits).toBeDefined();
    expect(siteWithAudits.baseURL).toBe(baseUrl);
    expect(siteWithAudits.audits).toBeInstanceOf(Array);
  });

  test('getSiteByBaseURL', async () => {
    const result = await getSiteByBaseURL('https://example1.com');
    expect(result).not.toBeNull();
    expect(result).toBeDefined();
    expect(result.baseURL).toBe('https://example1.com');
  });

  test('getSitesWithLatestAudit', async () => {
    const results = await getSitesWithLatestAudit('lhs');
    expect(results).toBeInstanceOf(Array);
  });

  test('getSiteByBaseURLWithLatestAudit', async () => {
    const result = await getSiteByBaseURLWithLatestAudit('https://example1.com', 'cwv');
    expect(result).not.toBeNull();
    expect(result).toBeDefined();
    expect(result.latestAudit).not.toBeNull();
    expect(result.latestAudit).toBeDefined();
  });

  test('getSitesToAudit', async () => {
    const baseURLs = await getSitesToAudit();
    expect(baseURLs).toBeInstanceOf(Array);
  });
});
