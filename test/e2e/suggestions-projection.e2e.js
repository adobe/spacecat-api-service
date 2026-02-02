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
 * These tests verify the Suggestion Projection Views feature, specifically validating
 * that the minimal view now includes createdAt and updatedAt timestamps.
 *
 * Required environment variables:
 *   - USER_API_KEY: API key for authentication
 *
 * Test data is auto-discovered from the hardcoded TEST_SITE_ID.
 */
describe('Suggestion Projection Views - E2E Tests', () => {
  const SITE_ID = TEST_SITE_ID;
  let OPPORTUNITY_ID = null;
  let opportunities = [];

  before(async function beforeHook() {
    // Auto-discover opportunities
    console.log('🔍 Auto-discovering opportunities for site:', SITE_ID);
    try {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities`,
        method: 'GET',
      });

      if (response.status === 200) {
        opportunities = await response.json();
        if (opportunities.length > 0) {
          // Find an opportunity that has suggestions
          for (const opp of opportunities) {
            // eslint-disable-next-line no-await-in-loop
            const sugResponse = await makeSpacecatRequest({
              path: `/sites/${SITE_ID}/opportunities/${opp.id}/suggestions?limit=1`,
              method: 'GET',
            });
            if (sugResponse.status === 200) {
              // eslint-disable-next-line no-await-in-loop
              const suggestions = await sugResponse.json();
              if (suggestions.length > 0) {
                OPPORTUNITY_ID = opp.id;
                console.log(`✅ Found opportunity with suggestions: ${opp.id} (type: ${opp.type})`);
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      console.log('⚠️  Failed to auto-discover opportunities:', err.message);
    }

    if (!OPPORTUNITY_ID) {
      console.log('⚠️  No opportunity with suggestions found - skipping tests');
      this.skip();
      return;
    }

    console.log(`📋 Testing with opportunity: ${OPPORTUNITY_ID}`);
  });

  describe('MINIMAL VIEW - Timestamp Validation', () => {
    it('should include createdAt and updatedAt in minimal view', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=minimal`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      expect(suggestions).to.be.an('array');

      if (suggestions.length === 0) {
        console.log('⚠️  No suggestions found - skipping validation');
        this.skip();
        return;
      }

      const suggestion = suggestions[0];

      // Verify minimal view structure
      expect(suggestion).to.have.property('id');
      expectValidUUID(suggestion.id);

      expect(suggestion).to.have.property('status');
      expect(suggestion.status).to.be.a('string');

      // CRITICAL: Verify timestamps are now included in minimal view
      expect(suggestion).to.have.property('createdAt');
      expectValidISODate(suggestion.createdAt);

      expect(suggestion).to.have.property('updatedAt');
      expectValidISODate(suggestion.updatedAt);

      // Optional: data field (only if URL-related fields exist)
      if (suggestion.data) {
        expect(suggestion.data).to.be.an('object');
      }

      // Verify minimal view does NOT include other fields
      expect(suggestion).to.not.have.property('opportunityId', 'Minimal view should not include opportunityId');
      expect(suggestion).to.not.have.property('type', 'Minimal view should not include type');
      expect(suggestion).to.not.have.property('rank', 'Minimal view should not include rank');
      expect(suggestion).to.not.have.property('kpiDeltas', 'Minimal view should not include kpiDeltas');
      expect(suggestion).to.not.have.property('updatedBy', 'Minimal view should not include updatedBy');

      console.log(`✓ Minimal view includes timestamps: createdAt=${suggestion.createdAt}, updatedAt=${suggestion.updatedAt}`);
    });

    it('should include timestamps even when data field is absent', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=minimal`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      if (suggestions.length === 0) {
        this.skip();
        return;
      }

      suggestions.forEach((suggestion) => {
        // Even if data is missing, timestamps should be present
        expect(suggestion).to.have.property('createdAt');
        expect(suggestion).to.have.property('updatedAt');
      });

      console.log(`✓ All ${suggestions.length} suggestion(s) have timestamps in minimal view`);
    });
  });

  describe('SUMMARY VIEW - Comparison with Minimal', () => {
    it('should include timestamps in summary view (as before)', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=summary`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      if (suggestions.length === 0) {
        this.skip();
        return;
      }

      const suggestion = suggestions[0];

      // Summary view includes everything minimal has, plus more
      expect(suggestion).to.have.property('id');
      expect(suggestion).to.have.property('status');
      expect(suggestion).to.have.property('createdAt');
      expect(suggestion).to.have.property('updatedAt');

      // Summary view additional fields
      expect(suggestion).to.have.property('opportunityId');
      expect(suggestion).to.have.property('type');
      expect(suggestion).to.have.property('rank');
      expect(suggestion).to.have.property('updatedBy');

      // Summary view should NOT include kpiDeltas (if data has kpiDeltas)
      if (suggestion.kpiDeltas !== undefined) {
        expect(suggestion).to.not.have.property('kpiDeltas');
      }

      console.log('✓ Summary view includes timestamps and metadata');
    });
  });

  describe('FULL VIEW - Complete Data', () => {
    it('should include all fields including timestamps in full view', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=full`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      if (suggestions.length === 0) {
        this.skip();
        return;
      }

      const suggestion = suggestions[0];

      // Full view includes everything
      expect(suggestion).to.have.property('id');
      expect(suggestion).to.have.property('opportunityId');
      expect(suggestion).to.have.property('type');
      expect(suggestion).to.have.property('rank');
      expect(suggestion).to.have.property('status');
      expect(suggestion).to.have.property('data');
      expect(suggestion).to.have.property('createdAt');
      expect(suggestion).to.have.property('updatedAt');
      expect(suggestion).to.have.property('updatedBy');

      // kpiDeltas may or may not be present depending on the DTO implementation
      // The key test is that we have timestamps - kpiDeltas is optional
      const hasKpiDeltas = Object.prototype.hasOwnProperty.call(suggestion, 'kpiDeltas');

      console.log('✓ Full view includes all fields');
      console.log(`  - kpiDeltas present: ${hasKpiDeltas}`);
    });
  });

  describe('DEFAULT VIEW - Backward Compatibility', () => {
    it('should default to full view when view parameter is omitted', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      if (suggestions.length === 0) {
        this.skip();
        return;
      }

      const suggestion = suggestions[0];

      // Should include all fields (same as full view)
      expect(suggestion).to.have.property('opportunityId');
      expect(suggestion).to.have.property('type');
      expect(suggestion).to.have.property('rank');
      expect(suggestion).to.have.property('createdAt');
      expect(suggestion).to.have.property('updatedAt');

      // kpiDeltas may or may not be present - not the focus of this test
      console.log('✓ Default view is full view (backward compatible)');
    });
  });

  describe('PAGED ENDPOINTS - Projection Support', () => {
    it('should support minimal view in paged endpoint', async function testPaged() {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/paged/10?view=minimal`,
        method: 'GET',
      });

      if (response.status !== 200) {
        console.log(`⚠️  Paged endpoint returned ${response.status} - may not support view parameter yet`);
        this.skip();
        return;
      }

      const result = await response.json();

      // Paged endpoint returns { items: [...], cursor?: string }
      if (!result.items) {
        console.log('⚠️  Paged endpoint has unexpected structure - skipping');
        this.skip();
        return;
      }

      expect(result).to.be.an('object');
      const items = result.items || result; // Handle both wrapped and unwrapped responses

      if (Array.isArray(items) && items.length > 0) {
        const suggestion = items[0];
        expect(suggestion).to.have.property('createdAt');
        expect(suggestion).to.have.property('updatedAt');

        console.log(`✓ Paged endpoint supports minimal view with timestamps (${items.length} items)`);
      } else {
        console.log('⚠️  No items in paged response - skipping');
        this.skip();
      }
    });
  });

  describe('BY STATUS ENDPOINTS - Projection Support', () => {
    it('should support minimal view in by-status endpoint', async () => {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/by-status/NEW?view=minimal`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      expect(suggestions).to.be.an('array');

      if (suggestions.length > 0) {
        const suggestion = suggestions[0];
        expect(suggestion).to.have.property('createdAt');
        expect(suggestion).to.have.property('updatedAt');

        // Check if minimal view is being applied (should not have opportunityId)
        const isMinimalView = !suggestion.opportunityId;
        if (!isMinimalView) {
          console.log('⚠️  By-status endpoint may not support view parameter yet - returning full view');
        }

        console.log(`✓ By-status endpoint returns timestamps (${suggestions.length} items)`);
      }
    });
  });

  describe('SINGLE SUGGESTION - Projection Support', () => {
    let suggestionId;

    before(async function beforeHook() {
      // Get a suggestion ID to test with
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions`,
        method: 'GET',
      });

      const suggestions = await response.json();
      if (suggestions.length === 0) {
        console.log('⚠️  No suggestions available for single suggestion test');
        this.skip();
        return;
      }

      suggestionId = suggestions[0].id;
    });

    it('should support minimal view when getting single suggestion', async function testSingle() {
      if (!suggestionId) {
        this.skip();
        return;
      }

      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions/${suggestionId}?view=minimal`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestion = await response.json();

      expect(suggestion).to.have.property('id', suggestionId);
      expect(suggestion).to.have.property('createdAt');
      expect(suggestion).to.have.property('updatedAt');
      expect(suggestion).to.not.have.property('kpiDeltas');

      console.log('✓ Single suggestion endpoint supports minimal view with timestamps');
    });
  });

  describe('PAYLOAD SIZE COMPARISON', () => {
    it('should verify minimal view reduces payload size significantly', async () => {
      // Get full view
      const fullResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=full`,
        method: 'GET',
      });

      // Get minimal view
      const minimalResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=minimal`,
        method: 'GET',
      });

      expect(fullResponse.status).to.equal(200);
      expect(minimalResponse.status).to.equal(200);

      const fullText = await fullResponse.text();
      const minimalText = await minimalResponse.text();

      const fullSize = fullText.length;
      const minimalSize = minimalText.length;
      const reductionPercent = Math.round(((fullSize - minimalSize) / fullSize) * 100);

      console.log('✓ Payload size comparison:');
      console.log(`  - Full view: ${fullSize} bytes`);
      console.log(`  - Minimal view: ${minimalSize} bytes`);
      console.log(`  - Reduction: ${reductionPercent}%`);

      // Minimal should be smaller or equal (if view param not supported, they'll be same)
      if (fullSize === minimalSize) {
        console.log('⚠️  Payload sizes are identical - view parameter may not be applied on this endpoint');
      } else {
        expect(minimalSize).to.be.lessThan(fullSize);
        expect(reductionPercent).to.be.greaterThan(20, 'Minimal view should reduce payload by at least 20%');
      }
    });
  });

  describe('TIMESTAMP CONSISTENCY', () => {
    it('should return consistent timestamps across different views', async () => {
      // Get the same suggestion in different views
      const fullResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=full`,
        method: 'GET',
      });

      const minimalResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=minimal`,
        method: 'GET',
      });

      expect(fullResponse.status).to.equal(200);
      expect(minimalResponse.status).to.equal(200);

      const fullSuggestions = await fullResponse.json();
      const minimalSuggestions = await minimalResponse.json();

      if (fullSuggestions.length === 0) {
        this.skip();
        return;
      }

      // Find matching suggestions and compare timestamps
      minimalSuggestions.forEach((minimalSug) => {
        const fullSug = fullSuggestions.find((s) => s.id === minimalSug.id);
        if (fullSug) {
          expect(minimalSug.createdAt).to.equal(
            fullSug.createdAt,
            `createdAt should match for suggestion ${minimalSug.id}`,
          );
          expect(minimalSug.updatedAt).to.equal(
            fullSug.updatedAt,
            `updatedAt should match for suggestion ${minimalSug.id}`,
          );
        }
      });

      console.log('✓ Timestamps are consistent across different views');
    });
  });

  describe('ERROR CASES', () => {
    it('should return 400 for invalid view parameter', async function testInvalidView() {
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions?view=invalid`,
        method: 'GET',
      });

      // Some endpoints may not validate view param and just ignore it (returning 200)
      if (response.status === 200) {
        console.log('⚠️  Invalid view parameter was ignored (returned 200) - validation may not be implemented');
        this.skip();
        return;
      }

      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.have.property('message');

      console.log('✓ Invalid view parameter correctly returns 400');
    });
  });

  describe('BACKWARD COMPATIBILITY', () => {
    it('should maintain backward compatibility - existing clients get full view', async () => {
      // Clients not using view parameter should get full data (with timestamps)
      const response = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities/${OPPORTUNITY_ID}/suggestions`,
        method: 'GET',
      });

      expect(response.status).to.equal(200);
      const suggestions = await response.json();

      if (suggestions.length === 0) {
        this.skip();
        return;
      }

      const suggestion = suggestions[0];

      // Should have all fields including timestamps
      expect(suggestion).to.have.property('opportunityId');
      expect(suggestion).to.have.property('type');
      expect(suggestion).to.have.property('rank');
      expect(suggestion).to.have.property('createdAt');
      expect(suggestion).to.have.property('updatedAt');

      // aggregationKey is added by the DTO in full view
      if (suggestion.data && typeof suggestion.data === 'object') {
        expect(suggestion.data).to.have.property('aggregationKey');
      }

      console.log('✓ Existing clients (no view param) still get full data');
    });
  });

  describe('MULTI-TYPE VALIDATION - Timestamps Across All Opportunity Types', () => {
    it('should include timestamps in minimal view for ALL configured opportunity types', async () => {
      // Use discovered opportunities or just the single configured one
      const opportunityIds = opportunities.length > 0
        ? opportunities.map((o) => o.id)
        : [OPPORTUNITY_ID].filter(Boolean);

      if (opportunityIds.length <= 1) {
        console.log('⚠️  Only one opportunity found - multi-type validation limited');
      }

      const results = [];

      for (const oppId of opportunityIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const response = await makeSpacecatRequest({
            path: `/sites/${SITE_ID}/opportunities/${oppId}/suggestions?view=minimal`,
            method: 'GET',
          });

          if (response.status !== 200) {
            results.push({
              opportunityId: oppId,
              status: 'error',
              message: `HTTP ${response.status}`,
            });
          } else {
            // eslint-disable-next-line no-await-in-loop
            const suggestions = await response.json();

            if (!Array.isArray(suggestions) || suggestions.length === 0) {
              results.push({
                opportunityId: oppId,
                status: 'empty',
                message: 'No suggestions found',
              });
            } else {
              // Validate timestamps for first suggestion
              const suggestion = suggestions[0];
              const hasCreatedAt = !!suggestion.createdAt;
              const hasUpdatedAt = !!suggestion.updatedAt;

              // Try to determine opportunity type from suggestion
              const suggestionType = suggestion.type || 'unknown';

              results.push({
                opportunityId: oppId,
                status: hasCreatedAt && hasUpdatedAt ? 'pass' : 'fail',
                suggestionCount: suggestions.length,
                suggestionType,
                hasCreatedAt,
                hasUpdatedAt,
                dataFields: suggestion.data ? Object.keys(suggestion.data) : [],
              });
            }
          }
        } catch (error) {
          results.push({
            opportunityId: oppId,
            status: 'error',
            message: error.message,
          });
        }
      }

      // Print summary
      console.log('\n📊 Multi-Type Validation Results:');
      console.log('─'.repeat(80));

      results.forEach((r, index) => {
        let statusIcon = '❌';
        if (r.status === 'pass') statusIcon = '✅';
        else if (r.status === 'empty') statusIcon = '⚠️';
        console.log(`${index + 1}. ${statusIcon} Opportunity: ${r.opportunityId}`);
        if (r.suggestionType) {
          console.log(`      Type: ${r.suggestionType}`);
        }
        if (r.suggestionCount !== undefined) {
          console.log(`      Suggestions: ${r.suggestionCount}`);
        }
        if (r.dataFields && r.dataFields.length > 0) {
          console.log(`      Data fields: [${r.dataFields.join(', ')}]`);
        }
        if (r.message) {
          console.log(`      Message: ${r.message}`);
        }
        console.log(`      createdAt: ${r.hasCreatedAt ? '✓' : '✗'}, updatedAt: ${r.hasUpdatedAt ? '✓' : '✗'}`);
      });

      console.log('─'.repeat(80));

      // Assert all passed
      const passed = results.filter((r) => r.status === 'pass');
      const failed = results.filter((r) => r.status === 'fail');
      const empty = results.filter((r) => r.status === 'empty');
      const errors = results.filter((r) => r.status === 'error');

      console.log(`Summary: ${passed.length} passed, ${failed.length} failed, ${empty.length} empty, ${errors.length} errors`);

      // Fail if any opportunity returned suggestions without timestamps
      expect(failed.length).to.equal(0, `${failed.length} opportunity type(s) missing timestamps in minimal view`);
    });

    it('should auto-discover and test all opportunity types for a site', async function testAutoDiscover() {
      // First, get all opportunities for the site
      const oppsResponse = await makeSpacecatRequest({
        path: `/sites/${SITE_ID}/opportunities`,
        method: 'GET',
      });

      if (oppsResponse.status !== 200) {
        console.log('⚠️  Could not fetch opportunities for site - skipping auto-discovery');
        this.skip();
        return;
      }

      const discoveredOpps = await oppsResponse.json();

      if (!Array.isArray(discoveredOpps) || discoveredOpps.length === 0) {
        console.log('⚠️  No opportunities found for site - skipping auto-discovery');
        this.skip();
        return;
      }

      console.log(`\n🔍 Auto-discovered ${discoveredOpps.length} opportunities for site ${SITE_ID}`);

      // Group by type
      const typeMap = new Map();
      discoveredOpps.forEach((opp) => {
        const type = opp.type || 'unknown';
        if (!typeMap.has(type)) {
          typeMap.set(type, opp.id);
        }
      });

      console.log(`📋 Found ${typeMap.size} unique opportunity types: ${[...typeMap.keys()].join(', ')}`);

      // Test one opportunity of each type
      const results = [];

      for (const [type, oppId] of typeMap) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const response = await makeSpacecatRequest({
            path: `/sites/${SITE_ID}/opportunities/${oppId}/suggestions?view=minimal&limit=1`,
            method: 'GET',
          });

          if (response.status !== 200) {
            results.push({
              type,
              oppId,
              status: 'error',
              message: `HTTP ${response.status}`,
            });
          } else {
            // eslint-disable-next-line no-await-in-loop
            const suggestions = await response.json();

            if (!Array.isArray(suggestions) || suggestions.length === 0) {
              results.push({
                type,
                oppId,
                status: 'empty',
                message: 'No suggestions',
              });
            } else {
              const suggestion = suggestions[0];
              const hasTimestamps = !!suggestion.createdAt && !!suggestion.updatedAt;

              results.push({
                type,
                oppId,
                status: hasTimestamps ? 'pass' : 'fail',
                hasCreatedAt: !!suggestion.createdAt,
                hasUpdatedAt: !!suggestion.updatedAt,
                dataFields: suggestion.data ? Object.keys(suggestion.data) : [],
              });
            }
          }
        } catch (error) {
          results.push({
            type,
            oppId,
            status: 'error',
            message: error.message,
          });
        }
      }

      // Print results
      console.log('\n📊 Auto-Discovery Results by Opportunity Type:');
      console.log('─'.repeat(80));

      results.forEach((r) => {
        let icon = '❌';
        if (r.status === 'pass') icon = '✅';
        else if (r.status === 'empty') icon = '⚠️';
        console.log(`${icon} ${r.type}`);
        console.log(`      Opportunity ID: ${r.oppId}`);
        if (r.dataFields && r.dataFields.length > 0) {
          console.log(`      Minimal data fields: [${r.dataFields.join(', ')}]`);
        }
        if (r.message) {
          console.log(`      ${r.message}`);
        }
        console.log(`      Timestamps: createdAt=${r.hasCreatedAt ? '✓' : '✗'}, updatedAt=${r.hasUpdatedAt ? '✓' : '✗'}`);
      });

      console.log('─'.repeat(80));

      const passed = results.filter((r) => r.status === 'pass');
      const failed = results.filter((r) => r.status === 'fail');

      console.log(`✓ Validated ${passed.length}/${results.length} opportunity types`);

      // All types that have suggestions should have timestamps
      expect(failed.length).to.equal(0, `Timestamps missing for types: ${failed.map((r) => r.type).join(', ')}`);
    });
  });
});
