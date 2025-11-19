/*
 * Copyright 2024 Adobe. All rights reserved.
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
import esmock from 'esmock';

describe('SiteMetricsCommand', () => {
  let SiteMetricsCommand;
  let contextMock;
  let slackContextMock;
  let siteMock;
  let dataAccessMock;
  let logMock;
  let extractURLStub;

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
  ];

  beforeEach(async () => {
    siteMock = {
      getId: sinon.stub().returns('site-123'),
      getBaseURL: sinon.stub().returns('https://example.com'),
    };

    dataAccessMock = {
      Site: {
        findByBaseURL: sinon.stub().resolves(siteMock),
      },
      Audit: {
        allBySiteId: sinon.stub().resolves(mockAudits),
      },
      Opportunity: {
        allBySiteId: sinon.stub().resolves(mockOpportunities),
      },
      Suggestion: {
        allByOpportunityId: sinon.stub().resolves(mockSuggestions),
      },
    };

    logMock = {
      error: sinon.stub(),
    };

    contextMock = {
      dataAccess: dataAccessMock,
      log: logMock,
    };

    slackContextMock = {
      say: sinon.stub().resolves(),
    };

    extractURLStub = sinon.stub().callsFake((url) => {
      if (!url.startsWith('http')) {
        return `https://${url}`;
      }
      return url;
    });

    SiteMetricsCommand = await esmock(
      '../../../../src/support/slack/commands/site-metrics.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLStub,
        },
        '../../../../src/support/site-metrics-service.js': {
          getSiteMetrics: sinon.stub().callsFake(async (context, siteId, startDate, endDate) => {
            // Mock the service to call the dataAccess methods we've already mocked
            const { dataAccess } = context;
            const allAudits = await dataAccess.Audit.allBySiteId(siteId);
            const allOpportunities = await dataAccess.Opportunity.allBySiteId(siteId);

            // Filter by date range
            const filteredAudits = allAudits.filter((audit) => {
              const auditDate = audit.getAuditedAt().split('T')[0];
              return auditDate >= startDate && auditDate <= endDate;
            });

            const filteredOpportunities = allOpportunities.filter((opp) => {
              const oppDate = opp.getCreatedAt().split('T')[0];
              return oppDate >= startDate && oppDate <= endDate;
            });

            // Calculate metrics
            const totalAudits = filteredAudits.length;
            const successfulAudits = filteredAudits.filter((a) => !a.getIsError()).length;
            const failedAudits = totalAudits - successfulAudits;
            const successRate = totalAudits > 0 ? ((successfulAudits / totalAudits) * 100).toFixed(1) : '0.0';

            // Breakdown by type
            const auditsByType = {};
            filteredAudits.forEach((audit) => {
              const type = audit.getAuditType();
              if (!auditsByType[type]) {
                auditsByType[type] = { total: 0, successful: 0, failed: 0 };
              }
              auditsByType[type].total += 1;
              if (audit.getIsError()) {
                auditsByType[type].failed += 1;
              } else {
                auditsByType[type].successful += 1;
              }
            });

            const opportunitiesByType = {};
            filteredOpportunities.forEach((opp) => {
              const type = opp.getType();
              opportunitiesByType[type] = (opportunitiesByType[type] || 0) + 1;
            });

            // Get suggestions
            const allSuggestions = [];
            // eslint-disable-next-line no-restricted-syntax
            for (const opp of filteredOpportunities) {
              // eslint-disable-next-line no-await-in-loop
              const suggestions = await dataAccess.Suggestion.allByOpportunityId(opp.getId());
              allSuggestions.push(...suggestions);
            }

            const suggestionsByStatus = {};
            allSuggestions.forEach((sugg) => {
              const status = sugg.getStatus();
              suggestionsByStatus[status] = (suggestionsByStatus[status] || 0) + 1;
            });

            return {
              siteId,
              startDate,
              endDate,
              audits: {
                total: totalAudits,
                successful: successfulAudits,
                failed: failedAudits,
                successRate: parseFloat(successRate),
                byType: auditsByType,
              },
              opportunities: {
                total: filteredOpportunities.length,
                byType: opportunitiesByType,
              },
              suggestions: {
                total: allSuggestions.length,
                byStatus: suggestionsByStatus,
              },
            };
          }),
          validateAndNormalizeDates: sinon.stub().callsFake((startDateInput, endDateInput) => {
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

            const startDate = startDateInput || '2000-01-01';
            const endDate = endDateInput || new Date().toISOString().split('T')[0];

            // Validate start date format
            if (startDateInput && !dateRegex.test(startDateInput)) {
              return { error: 'Invalid start date format. Use YYYY-MM-DD format.' };
            }

            // Validate end date format
            if (endDateInput && !dateRegex.test(endDateInput)) {
              return { error: 'Invalid end date format. Use YYYY-MM-DD format.' };
            }

            if (startDate > endDate) {
              return { error: 'Start date must be before or equal to end date.' };
            }

            return { startDate, endDate, error: null };
          }),
        },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Command Configuration', () => {
    it('should have correct command configuration', () => {
      const command = SiteMetricsCommand(contextMock);
      expect(command.id).to.equal('sites--get-metrics');
      expect(command.name).to.equal('Get Site Metrics');
      expect(command.phrases).to.deep.equal(['site-metrics']);
    });
  });

  describe('Input Validation', () => {
    it('should reject when no site URL is provided', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution([], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match(':x: Please provide a site URL'))).to.be.true;
    });

    it('should reject when site is not found', async () => {
      dataAccessMock.Site.findByBaseURL.resolves(null);

      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://nonexistent.com'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match(':x: Site not found'))).to.be.true;
    });

    it('should reject invalid start date format', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com', 'invalid-date'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid start date format'))).to.be.true;
    });

    it('should reject invalid end date format', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com', '2025-01-01', 'invalid-date'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid end date format'))).to.be.true;
    });

    it('should reject when start date is after end date', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com', '2025-02-01', '2025-01-01'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match(/Start date.*must be before or equal to end date/))).to.be.true;
    });
  });

  describe('Metrics Retrieval', () => {
    it('should fetch and display metrics for all time when no dates provided', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      // Should show loading message
      expect(slackContextMock.say.calledWith(':hourglass_flowing_sand: Fetching metrics for site...')).to.be.true;

      // Should display results in a single joined message (last call)
      const calls = slackContextMock.say.getCalls();
      expect(calls.length).to.be.at.least(2); // loading + final message

      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('Metrics for Site: https://example.com');
      expect(message).to.include('Period:* All time');
      expect(message).to.include('Total: *3* audits run');
      expect(message).to.include('Total: *2* opportunities');
      expect(message).to.include('Total: *4* suggestions');
    });

    it('should fetch and display metrics for specific date range', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com', '2025-01-15', '2025-01-16'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('Period:* 2025-01-15 to 2025-01-16');
      // Should filter audits by date - only 2 audits in this range
      expect(message).to.include('Total: *2* audits run');
    });

    it('should handle URL without scheme', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['example.com'], slackContextMock);

      expect(extractURLStub.calledWith('example.com')).to.be.true;
      expect(dataAccessMock.Site.findByBaseURL.calledWith('https://example.com')).to.be.true;
    });

    it('should display audit breakdown by type', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('_Breakdown by Audit Type:_');
      expect(message).to.include('`cwv`: (✅ 1 | ❌ 1)');
      expect(message).to.include('`broken-backlinks`: (✅ 1)');
    });

    it('should display opportunity breakdown by type', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('_Breakdown by Opportunity Type:_');
      expect(message).to.include('`seo-backlinks`: (✅ 1)');
      expect(message).to.include('`cwv-lcp`: (✅ 1)');
    });

    it('should display suggestion breakdown by status', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('_Breakdown by Suggestion Status:_');
      expect(message).to.include('`NEW`: (✅ 2)');
      expect(message).to.include('`APPROVED`: (✅ 2)');
    });

    it('should calculate success rate correctly', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      // 2 successful out of 3 total = 66.7%
      expect(message).to.include('66.7%');
    });
  });

  describe('Empty Results Handling', () => {
    it('should handle site with no data', async () => {
      dataAccessMock.Audit.allBySiteId.resolves([]);
      dataAccessMock.Opportunity.allBySiteId.resolves([]);

      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      const calls = slackContextMock.say.getCalls();
      const lastCall = calls[calls.length - 1];
      const message = lastCall.args[0];

      expect(message).to.include('No data found for this site');
      expect(message).to.include('_No audits found for this period_');
      expect(message).to.include('_No opportunities found for this period_');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors during metrics fetching', async () => {
      const error = new Error('Database connection failed');
      dataAccessMock.Audit.allBySiteId.rejects(error);

      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      expect(logMock.error.called).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match(/:x:.*An error occurred/))).to.be.true;
    });
  });
});
