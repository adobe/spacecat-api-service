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

      expect(slackContextMock.say.calledWith(sinon.match('Start date'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('cannot be after end date'))).to.be.true;
    });
  });

  describe('Metrics Retrieval', () => {
    it('should fetch and display metrics for all time when no dates provided', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      // Should show loading message
      expect(slackContextMock.say.calledWith(':hourglass_flowing_sand: Fetching metrics for site...')).to.be.true;

      // Should display results
      expect(slackContextMock.say.calledWith(sinon.match('Metrics for Site: https://example.com'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Period:* All time'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Total Audits: 3'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Total Opportunities: 2'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Total Suggestions: 4'))).to.be.true; // 2 suggestions per opportunity
    });

    it('should fetch and display metrics for specific date range', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com', '2025-01-15', '2025-01-16'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Period:* 2025-01-15 to 2025-01-16'))).to.be.true;
      // Should filter audits by date - only 2 audits in this range
      expect(slackContextMock.say.calledWith(sinon.match('Total Audits: 2'))).to.be.true;
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

      expect(slackContextMock.say.calledWith(sinon.match('Breakdown by Audit Type'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*cwv*'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*broken-backlinks*'))).to.be.true;
    });

    it('should display opportunity breakdown by type', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Breakdown by Opportunity Type'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*seo-backlinks*'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*cwv-lcp*'))).to.be.true;
    });

    it('should display suggestion breakdown by status', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Breakdown by Status'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*NEW*'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('*APPROVED*'))).to.be.true;
    });

    it('should calculate success rate correctly', async () => {
      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      // 2 successful out of 3 total = 66.7%
      expect(slackContextMock.say.calledWith(sinon.match('66.7%'))).to.be.true;
    });
  });

  describe('Empty Results Handling', () => {
    it('should handle site with no data', async () => {
      dataAccessMock.Audit.allBySiteId.resolves([]);
      dataAccessMock.Opportunity.allBySiteId.resolves([]);

      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('No data found for this site'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('_No audits found for this period_'))).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('_No opportunities found for this period_'))).to.be.true;
    });
  });

  describe('Error Handling', () => {
    it('should handle errors during metrics fetching', async () => {
      const error = new Error('Database connection failed');
      dataAccessMock.Audit.allBySiteId.rejects(error);

      const command = SiteMetricsCommand(contextMock);
      await command.handleExecution(['https://example.com'], slackContextMock);

      expect(logMock.error.calledWith('Error fetching site metrics:', error)).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match(':x: An error occurred'))).to.be.true;
    });
  });
});
