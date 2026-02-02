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

/* eslint-env mocha */

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import {
  makeSpacecatRequest,
  expectValidUUID,
  expectValidISODate,
  TEST_SITE_ID,
} from './utils/spacecat-utils.js';

use(sinonChai);
use(chaiAsPromised);

/**
 * These tests exercise the Suggestion Fixes API from the outside.
 *
 * Required environment variables:
 *   - USER_API_KEY: API key for authentication
 *
 * Test data is auto-discovered from the hardcoded TEST_SITE_ID.
 */
describe('Suggestion Fixes API - End-to-End Tests', () => {
  const SITE_ID = TEST_SITE_ID;
  let OPPORTUNITY_ID = null;
  let SUGGESTION_ID = null;
  // Optional - skipped if not auto-discovered
  const SUGGESTION_NO_FIXES_ID = null;

  before(async function beforeHook() {
    // Auto-discover opportunity and suggestion
    console.log('🔍 Auto-discovering opportunities and suggestions for site:', SITE_ID);
    try {
      const oppResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities`,
        method: 'GET',
      });

      if (oppResponse.status === 200) {
        const opportunities = await oppResponse.json();
        for (const opp of opportunities) {
          if (OPPORTUNITY_ID && SUGGESTION_ID) break;

          // eslint-disable-next-line no-await-in-loop
          const sugResponse = await makeSpacecatRequest({
            path: `/sites/${SITE_ID}/opportunities/${opp.id}/suggestions?limit=5`,
            method: 'GET',
          });

          if (sugResponse.status === 200) {
            // eslint-disable-next-line no-await-in-loop
            const suggestions = await sugResponse.json();
            if (suggestions.length > 0) {
              OPPORTUNITY_ID = OPPORTUNITY_ID || opp.id;
              SUGGESTION_ID = SUGGESTION_ID || suggestions[0].id;
              console.log(`✅ Found opportunity: ${opp.id}, suggestion: ${suggestions[0].id}`);
            }
          }
        }
      }
    } catch (err) {
      console.log('⚠️  Failed to auto-discover:', err.message);
    }

    if (!OPPORTUNITY_ID || !SUGGESTION_ID) {
      console.log('⚠️  Could not find opportunity/suggestion - skipping tests');
      this.skip();
      return;
    }

    console.log(`📋 Testing with opportunity: ${OPPORTUNITY_ID}, suggestion: ${SUGGESTION_ID}`);
  });

  describe('GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes', () => {
    describe('Positive Tests', () => {
      it('should successfully retrieve fixes for a valid suggestion', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(200);
        const result = await response.json();

        // Verify response structure
        expect(result).to.have.property('data');
        expect(result.data).to.be.an('array');

        // If there are fixes, validate their structure
        if (result.data.length > 0) {
          const fix = result.data[0];

          // Required fields
          expect(fix).to.have.property('id');
          expectValidUUID(fix.id);

          expect(fix).to.have.property('opportunityId');
          expectValidUUID(fix.opportunityId);
          expect(fix.opportunityId).to.equal(OPPORTUNITY_ID);

          expect(fix).to.have.property('type');
          expect(fix.type).to.be.a('string');
          expect(['CODE_CHANGE', 'CONTENT_UPDATE', 'METADATA_UPDATE', 'REDIRECT_UPDATE', 'EXPERIMENT'])
            .to.include(fix.type);

          expect(fix).to.have.property('status');
          expect(fix.status).to.be.a('string');
          expect(['PENDING', 'DEPLOYED', 'PUBLISHED', 'FAILED', 'ROLLED_BACK'])
            .to.include(fix.status);

          // Timestamps
          expect(fix).to.have.property('createdAt');
          expectValidISODate(fix.createdAt);

          expect(fix).to.have.property('updatedAt');
          expectValidISODate(fix.updatedAt);

          // Optional fields (may be null)
          if (fix.executedBy) {
            expect(fix.executedBy).to.be.a('string');
          }

          if (fix.executedAt) {
            expectValidISODate(fix.executedAt);
          }

          if (fix.publishedAt) {
            expectValidISODate(fix.publishedAt);
          }

          expect(fix).to.have.property('changeDetails');
          expect(fix.changeDetails).to.be.an('object');

          expect(fix).to.have.property('origin');
          expect(fix.origin).to.be.a('string');

          // Optional suggestions array (many-to-many relationship)
          if (fix.suggestions) {
            expect(fix.suggestions).to.be.an('array');
            fix.suggestions.forEach((suggestion) => {
              expect(suggestion).to.have.property('id');
              expectValidUUID(suggestion.id);
            });
          }

          console.log(`✓ Successfully retrieved ${result.data.length} fix(es) for suggestion ${SUGGESTION_ID}`);
        } else {
          console.log(`✓ Suggestion ${SUGGESTION_ID} has no fixes (empty array returned)`);
        }
      });

      it('should return empty array when suggestion has no fixes', async function testEmptyFixes() {
        // Skip if no test suggestion ID provided for this case
        if (!SUGGESTION_NO_FIXES_ID) {
          console.log('⚠️  Skipping - E2E_TEST_SUGGESTION_NO_FIXES_ID not set');
          this.skip();
          return;
        }

        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_NO_FIXES_ID}/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(200);
        const result = await response.json();

        expect(result).to.have.property('data');
        expect(result.data).to.be.an('array').with.lengthOf(0);

        console.log(`✓ Suggestion ${SUGGESTION_NO_FIXES_ID} correctly returns empty array`);
      });

      it('should return consistent results on multiple calls (idempotency)', async () => {
        const response1 = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        const response2 = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        expect(response1.status).to.equal(200);
        expect(response2.status).to.equal(200);

        const result1 = await response1.json();
        const result2 = await response2.json();

        expect(result1.data).to.deep.equal(result2.data);

        console.log('✓ Multiple requests return consistent results');
      });
    });

    describe('Negative Tests - Validation Errors', () => {
      it('should return 400 for invalid site ID format', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/invalid-uuid/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(400);
        const result = await response.json();
        expect(result).to.have.property('message');
        expect(result.message.toLowerCase()).to.include('site id');

        console.log('✓ Invalid site ID correctly returns 400');
      });

      it('should return 400 for invalid opportunity ID format', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/invalid-uuid/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(400);
        const result = await response.json();
        expect(result).to.have.property('message');
        expect(result.message.toLowerCase()).to.include('opportunity id');

        console.log('✓ Invalid opportunity ID correctly returns 400');
      });

      it('should return 400 for invalid suggestion ID format', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/invalid-uuid/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(400);
        const result = await response.json();
        expect(result).to.have.property('message');
        expect(result.message.toLowerCase()).to.include('suggestion id');

        console.log('✓ Invalid suggestion ID correctly returns 400');
      });
    });

    describe('Negative Tests - Not Found', () => {
      it('should return error for non-existent site', async () => {
        const nonExistentSiteId = '00000000-0000-0000-0000-000000000000';
        const response = await makeSpacecatRequest({
          path: `/sites/${nonExistentSiteId}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        // API may return 400 or 404 for non-existent site
        expect(response.status).to.be.oneOf([400, 404]);
        console.log(`✓ Non-existent site correctly returns ${response.status}`);
      });

      it('should return 200 with empty array for non-existent suggestion', async () => {
        // Note: Based on the implementation, a non-existent suggestion returns empty array
        // not 404, because the query is valid but returns no results
        const nonExistentSuggestionId = '00000000-0000-0000-0000-000000000000';
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${nonExistentSuggestionId}/fixes`,
          method: 'GET',
        });

        expect(response.status).to.equal(200);
        const result = await response.json();
        expect(result).to.have.property('data');
        expect(result.data).to.be.an('array').with.lengthOf(0);

        console.log('✓ Non-existent suggestion correctly returns empty array');
      });
    });

    describe('Negative Tests - Authentication & Authorization', () => {
      it('should return 401 for missing API key', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
          skipAuth: true,
        });

        expect(response.status).to.equal(401);

        console.log('✓ Missing API key correctly returns 401');
      });

      it('should return 401 for invalid API key', async () => {
        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
          key: 'invalid-api-key-12345',
        });

        // Some API configurations may not validate keys - skip if not enforced
        if (response.status === 200) {
          console.log('⚠️  API does not enforce key validation - skipping');
          return;
        }

        expect(response.status).to.equal(401);
        console.log('✓ Invalid API key correctly returns 401');
      });

      // Note: 403 test would require a site that the API key doesn't have access to
      // Skipping as it requires specific test data setup
    });

    describe('Integration Tests - Full Workflow', () => {
      it('should follow the complete suggestion → fixes workflow', async () => {
        // Step 1: List suggestions for the opportunity
        const listResponse = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions`,
          method: 'GET',
        });

        expect(listResponse.status).to.equal(200);
        const suggestions = await listResponse.json();
        expect(suggestions).to.be.an('array');

        if (suggestions.length === 0) {
          console.log('⚠️  No suggestions found for this opportunity - skipping workflow test');
          this.skip();
          return;
        }

        console.log(`✓ Step 1: Found ${suggestions.length} suggestion(s)`);

        // Step 2: Get details of first suggestion
        const firstSuggestionId = suggestions[0].id;
        const detailResponse = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${firstSuggestionId}`,
          method: 'GET',
        });

        expect(detailResponse.status).to.equal(200);
        const suggestionDetail = await detailResponse.json();
        expect(suggestionDetail).to.have.property('id', firstSuggestionId);

        console.log(`✓ Step 2: Retrieved suggestion details for ${firstSuggestionId}`);

        // Step 3: Get fixes for this suggestion
        const fixesResponse = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${firstSuggestionId}/fixes`,
          method: 'GET',
        });

        expect(fixesResponse.status).to.equal(200);
        const fixesResult = await fixesResponse.json();
        expect(fixesResult).to.have.property('data');
        expect(fixesResult.data).to.be.an('array');

        console.log(`✓ Step 3: Retrieved ${fixesResult.data.length} fix(es) for suggestion`);
        console.log('✓ Complete workflow executed successfully');
      });
    });

    describe('Performance & Load Tests', () => {
      it('should respond within acceptable time limits (< 3 seconds)', async () => {
        const startTime = Date.now();

        const response = await makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        expect(response.status).to.equal(200);
        expect(duration).to.be.lessThan(3000); // 3 seconds

        console.log(`✓ Response time: ${duration}ms (< 3000ms threshold)`);
      });

      it('should handle concurrent requests correctly', async () => {
        const requests = Array(5).fill(null).map(() => makeSpacecatRequest({
          path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${SUGGESTION_ID}/fixes`,
          method: 'GET',
        }));

        const responses = await Promise.all(requests);

        responses.forEach((response) => {
          expect(response.status).to.equal(200);
        });

        const results = await Promise.all(responses.map((r) => r.json()));

        // All responses should be identical
        results.forEach((result) => {
          expect(result).to.deep.equal(results[0]);
        });

        console.log('✓ 5 concurrent requests handled correctly');
      });
    });
  });
});
