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

import { expect } from 'chai';
import sinon from 'sinon';
import { getSiteMetrics, validateAndNormalizeDates } from '../../src/support/site-metrics-service.js';

describe('Site Metrics Service', () => {
  describe('validateAndNormalizeDates', () => {
    it('should return default dates when no inputs provided', () => {
      const result = validateAndNormalizeDates();

      expect(result.error).to.be.null;
      expect(result.startDate).to.equal('2000-01-01');
      expect(result.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/); // Today's date
    });

    it('should validate and normalize valid date inputs', () => {
      const result = validateAndNormalizeDates('2025-01-01', '2025-01-31');

      expect(result.error).to.be.null;
      expect(result.startDate).to.equal('2025-01-01');
      expect(result.endDate).to.equal('2025-01-31');
    });

    it('should return error for invalid start date format', () => {
      const result = validateAndNormalizeDates('invalid-date', '2025-01-31');

      expect(result.error).to.equal('Invalid start date format. Use YYYY-MM-DD format.');
    });

    it('should return error for invalid end date format', () => {
      const result = validateAndNormalizeDates('2025-01-01', 'not-a-date');

      expect(result.error).to.equal('Invalid end date format. Use YYYY-MM-DD format.');
    });

    it('should return error when start date is after end date', () => {
      const result = validateAndNormalizeDates('2025-12-31', '2025-01-01');

      expect(result.error).to.equal('Start date must be before or equal to end date.');
    });

    it('should accept start date equal to end date', () => {
      const result = validateAndNormalizeDates('2025-01-15', '2025-01-15');

      expect(result.error).to.be.null;
      expect(result.startDate).to.equal('2025-01-15');
      expect(result.endDate).to.equal('2025-01-15');
    });

    it('should use today as end date when only start date provided', () => {
      const result = validateAndNormalizeDates('2025-01-01');

      expect(result.error).to.be.null;
      expect(result.startDate).to.equal('2025-01-01');
      expect(result.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getSiteMetrics', () => {
    let contextMock;
    let dataAccessMock;
    let logMock;

    const mockAudits = [
      {
        getId: () => 'audit-1',
        getAuditType: () => 'cwv',
        getAuditedAt: () => '2025-01-15T10:00:00Z',
        getIsError: () => false,
      },
      {
        getId: () => 'audit-2',
        getAuditType: () => 'cwv',
        getAuditedAt: () => '2025-01-16T10:00:00Z',
        getIsError: () => true,
      },
      {
        getId: () => 'audit-3',
        getAuditType: () => 'broken-backlinks',
        getAuditedAt: () => '2025-01-17T10:00:00Z',
        getIsError: () => false,
      },
      {
        getId: () => 'audit-4',
        getAuditType: () => 'seo',
        getAuditedAt: () => '2025-01-18T10:00:00Z',
        getIsError: () => false,
      },
    ];

    const mockOpportunities = [
      {
        getId: () => 'opp-1',
        getType: () => 'seo-backlinks',
        getCreatedAt: () => '2025-01-15T12:00:00Z',
      },
      {
        getId: () => 'opp-2',
        getType: () => 'cwv-lcp',
        getCreatedAt: () => '2025-01-16T12:00:00Z',
      },
      {
        getId: () => 'opp-3',
        getType: () => 'seo-backlinks',
        getCreatedAt: () => '2025-01-17T12:00:00Z',
      },
    ];

    const mockSuggestions = [
      {
        getId: () => 'sugg-1',
        getStatus: () => 'NEW',
        getCreatedAt: () => '2025-01-15T13:00:00Z',
      },
      {
        getId: () => 'sugg-2',
        getStatus: () => 'APPROVED',
        getCreatedAt: () => '2025-01-16T13:00:00Z',
      },
      {
        getId: () => 'sugg-3',
        getStatus: () => 'NEW',
        getCreatedAt: () => '2025-01-17T13:00:00Z',
      },
    ];

    beforeEach(() => {
      logMock = {
        info: sinon.stub(),
        error: sinon.stub(),
      };

      dataAccessMock = {
        Audit: {
          allBySiteId: sinon.stub().resolves(mockAudits),
        },
        Opportunity: {
          allBySiteId: sinon.stub().resolves(mockOpportunities),
        },
        Suggestion: {
          allByOpportunityId: sinon.stub()
            .onFirstCall().resolves([mockSuggestions[0]])
            .onSecondCall()
            .resolves([mockSuggestions[1]])
            .onThirdCall()
            .resolves([mockSuggestions[2]]),
        },
      };

      contextMock = {
        dataAccess: dataAccessMock,
        log: logMock,
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should fetch and calculate metrics for all time when no dates provided', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(metrics.siteId).to.equal('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(metrics.startDate).to.equal('2000-01-01');
      expect(metrics.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      expect(metrics.audits.total).to.equal(4);
      expect(metrics.audits.successful).to.equal(3);
      expect(metrics.audits.failed).to.equal(1);
      expect(metrics.audits.successRate).to.equal(75.0);

      expect(metrics.opportunities.total).to.equal(3);
      expect(metrics.suggestions.total).to.equal(3);
    });

    it('should filter metrics by date range', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2025-01-15', '2025-01-16');

      expect(metrics.audits.total).to.equal(2); // Only audits from 15th and 16th
      expect(metrics.opportunities.total).to.equal(2);
      expect(metrics.suggestions.total).to.equal(2);
    });

    it('should return 0.0 success rate when no audits', async () => {
      dataAccessMock.Audit.allBySiteId.resolves([]);
      dataAccessMock.Opportunity.allBySiteId.resolves([]);

      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(metrics.audits.total).to.equal(0);
      expect(metrics.audits.byType).to.deep.equal({});
      expect(metrics.audits.successRate).to.equal(0.0);
      expect(metrics.opportunities.total).to.equal(0);
      expect(metrics.opportunities.byType).to.deep.equal({});
      expect(metrics.suggestions.total).to.equal(0);
      expect(metrics.suggestions.byStatus).to.deep.equal({});
    });

    it('should breakdown audits by type', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(metrics.audits.byType).to.deep.equal({
        cwv: { total: 2, successful: 1, failed: 1 },
        'broken-backlinks': { total: 1, successful: 1, failed: 0 },
        seo: { total: 1, successful: 1, failed: 0 },
      });
    });

    it('should breakdown opportunities by type', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(metrics.opportunities.byType).to.deep.equal({
        'seo-backlinks': 2,
        'cwv-lcp': 1,
      });
    });

    it('should breakdown suggestions by status', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(metrics.suggestions.byStatus).to.deep.equal({
        NEW: 2,
        APPROVED: 1,
      });
    });

    it('should log info message when fetching metrics', async () => {
      await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2025-01-01', '2025-01-31');

      expect(logMock.info.calledOnce).to.be.true;
      expect(logMock.info.firstCall.args[0]).to.include('Fetching metrics for site a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(logMock.info.firstCall.args[0]).to.include('2025-01-01');
      expect(logMock.info.firstCall.args[0]).to.include('2025-01-31');
    });

    it('should use default end date when not provided', async () => {
      const metrics = await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2025-01-01');

      expect(metrics.startDate).to.equal('2025-01-01');
      expect(metrics.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should fetch suggestions for all opportunities', async () => {
      await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(dataAccessMock.Suggestion.allByOpportunityId.callCount).to.equal(3);
      expect(dataAccessMock.Suggestion.allByOpportunityId.firstCall.args[0]).to.equal('opp-1');
      expect(dataAccessMock.Suggestion.allByOpportunityId.secondCall.args[0]).to.equal('opp-2');
      expect(dataAccessMock.Suggestion.allByOpportunityId.thirdCall.args[0]).to.equal('opp-3');
    });

    it('should pass order parameter to Audit.allBySiteId', async () => {
      await getSiteMetrics(contextMock, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(dataAccessMock.Audit.allBySiteId.calledWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890', { order: 'desc' })).to.be.true;
    });
  });
});
