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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import RunReportCommand from '../../../../src/support/slack/commands/run-report.js';

use(sinonChai);

describe('RunReportCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let mockSite;
  let mockEnv;
  let globalFetch;

  beforeEach(() => {
    // Mock site object
    mockSite = {
      getId: sinon.stub().returns('123e4567-e89b-12d3-a456-426614174000'),
    };

    // Mock data access
    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub().resolves(mockSite),
      },
    };

    // Mock environment
    mockEnv = {
      SPACECAT_API_BASE_URL: 'https://api.spacecat.com',
      USER_API_KEY: 'test-api-key',
    };

    // Mock context
    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      env: mockEnv,
    };

    // Mock Slack context
    slackContext = {
      say: sinon.stub(),
    };

    // Mock global fetch
    globalFetch = global.fetch;
    global.fetch = sinon.stub();
  });

  afterEach(() => {
    global.fetch = globalFetch;
    sinon.restore();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('should initialize correctly with base command properties', () => {
      const command = RunReportCommand(context);

      expect(command.id).to.equal('run-report');
      expect(command.name).to.equal('Run Report');
      expect(command.description).to.equal('Generate a report for a site with specified parameters including report type, name, report period, and comparison period.');
      expect(command.phrases).to.deep.equal(['run report']);
    });

    it('should accept messages starting with "run report"', () => {
      const command = RunReportCommand(context);

      expect(command.accepts('run report')).to.be.true;
      expect(command.accepts('run report https://example.com performance')).to.be.true;
      expect(command.accepts('run report https://example.com optimization')).to.be.true;
      expect(command.accepts('not run report')).to.be.false;
      expect(command.accepts('runreport')).to.be.false;
    });
  });

  describe('Name Sanitization', () => {
    it('should sanitize report names correctly', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const testCases = [
        { input: 'MONTHLY REPORT', expected: 'Monthly report' },
        { input: '  weekly summary  ', expected: 'Weekly summary' },
        { input: 'q1 analysis', expected: 'Q1 analysis' },
        { input: 'PERFORMANCE   METRICS', expected: 'Performance metrics' },
        { input: 'test', expected: 'Test' },
        { input: 'a', expected: 'A' },
        { input: '', expected: '' },
        { input: '   ', expected: '' },
      ];

      for (const testCase of testCases) {
        const args = [
          'https://example.com',
          'performance',
          testCase.input,
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        const fetchCall = global.fetch.lastCall;
        const requestBody = JSON.parse(fetchCall.args[1].body);
        expect(requestBody.name).to.equal(testCase.expected);

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
      }
    });

    it('should generate default names from URL when name is null or undefined', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const testCases = [
        { url: 'https://example.com', expected: 'Example.com' },
        { url: 'https://www.example.com', expected: 'Example.com' },
        { url: 'https://my-site.com', expected: 'My-site.com' },
        { url: 'https://subdomain.example.com', expected: 'Subdomain.example.com' },
      ];

      for (const testCase of testCases) {
        const args = [
          testCase.url,
          'performance',
          null, // null name
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        const fetchCall = global.fetch.lastCall;
        const requestBody = JSON.parse(fetchCall.args[1].body);
        expect(requestBody.name).to.equal(testCase.expected);

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
      }
    });
  });

  describe('Date Validation', () => {
    it('should validate date format correctly', async () => {
      const command = RunReportCommand(context);
      const invalidDateFormats = [
        '2025/01/01', // Wrong separator
        '01-01-2025', // Wrong order
        '2025-1-1', // Single digits
        '25-01-01', // Two digit year
        '2025-13-01', // Invalid month
        '2025-01-32', // Invalid day
        '2025-02-30', // Invalid date
        'invalid-date', // Completely invalid
        '   ', // Whitespace only
      ];

      for (const invalidDate of invalidDateFormats) {
        const args = [
          'https://example.com',
          'performance',
          'Test report',
          invalidDate,
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        expect(slackContext.say).to.have.been.calledTwice;
        expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');

        // Reset for next iteration
        slackContext.say.resetHistory();
      }
    });

    it('should validate date relationships correctly', async () => {
      const command = RunReportCommand(context);
      const invalidDateRelations = [
        {
          reportStart: '2025-01-31',
          reportEnd: '2025-01-01',
          error: 'Report period start date must be less than or equal to end date',
        },
        {
          comparisonStart: '2024-12-31',
          comparisonEnd: '2024-12-01',
          error: 'Comparison period start date must be less than or equal to end date',
        },
      ];

      for (const testCase of invalidDateRelations) {
        const args = [
          'https://example.com',
          'performance',
          'Test report',
          testCase.reportStart || '2025-01-01',
          testCase.reportEnd || '2025-01-31',
          testCase.comparisonStart || '2024-12-01',
          testCase.comparisonEnd || '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        expect(slackContext.say).to.have.been.calledTwice;
        expect(slackContext.say.secondCall.args[0]).to.include(`:warning: ${testCase.error}`);

        // Reset for next iteration
        slackContext.say.resetHistory();
      }
    });
  });

  describe('Default Date Generation', () => {
    it('should generate default report period dates when both are undefined', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        undefined, // reportStartDate
        undefined, // reportEndDate
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);

      // Should have generated dates (one month back to current date)
      expect(requestBody.reportPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.reportPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      // The end date should be today or very recent
      const endDate = new Date(requestBody.reportPeriod.endDate);
      const today = new Date();
      const diffInDays = Math.abs(today - endDate) / (1000 * 60 * 60 * 24);
      expect(diffInDays).to.be.lessThan(2); // Allow for 1 day difference due to timing
    });

    it('should generate default report period dates when both are null', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        null, // reportStartDate
        null, // reportEndDate
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);

      // Should have generated dates (one month back to current date)
      expect(requestBody.reportPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.reportPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      // The end date should be today or very recent
      const endDate = new Date(requestBody.reportPeriod.endDate);
      const today = new Date();
      const diffInDays = Math.abs(today - endDate) / (1000 * 60 * 60 * 24);
      expect(diffInDays).to.be.lessThan(2); // Allow for 1 day difference due to timing
    });

    it('should generate default comparison period dates when both are undefined', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        undefined, // comparisonStartDate
        undefined, // comparisonEndDate
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);

      // Should have generated comparison dates (two months back to one month back)
      expect(requestBody.comparisonPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.comparisonPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      // The comparison end date should be approximately one month ago
      const comparisonEndDate = new Date(requestBody.comparisonPeriod.endDate);
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const diffInDays = Math.abs(oneMonthAgo - comparisonEndDate) / (1000 * 60 * 60 * 24);
      expect(diffInDays).to.be.lessThan(2); // Allow for 1 day difference due to timing
    });

    it('should generate default comparison period dates when both are null', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        null, // comparisonStartDate
        null, // comparisonEndDate
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);

      // Should have generated comparison dates (two months back to one month back)
      expect(requestBody.comparisonPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.comparisonPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      // The comparison end date should be approximately one month ago
      const comparisonEndDate = new Date(requestBody.comparisonPeriod.endDate);
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const diffInDays = Math.abs(oneMonthAgo - comparisonEndDate) / (1000 * 60 * 60 * 24);
      expect(diffInDays).to.be.lessThan(2); // Allow for 1 day difference due to timing
    });

    it('should generate default dates for both report and comparison periods when all are undefined', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        undefined, // reportStartDate
        undefined, // reportEndDate
        undefined, // comparisonStartDate
        undefined, // comparisonEndDate
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);

      // Should have generated all dates
      expect(requestBody.reportPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.reportPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.comparisonPeriod.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(requestBody.comparisonPeriod.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);

      // Verify the date relationships
      const reportStart = new Date(requestBody.reportPeriod.startDate);
      const reportEnd = new Date(requestBody.reportPeriod.endDate);
      const comparisonStart = new Date(requestBody.comparisonPeriod.startDate);
      const comparisonEnd = new Date(requestBody.comparisonPeriod.endDate);

      // Report period should be one month (start should be before end)
      expect(reportStart.getTime()).to.be.lessThan(reportEnd.getTime());

      // Comparison period should be one month (start should be before end)
      expect(comparisonStart.getTime()).to.be.lessThan(comparisonEnd.getTime());

      // Comparison period should be before report period (allow for same time due to timing)
      expect(comparisonEnd.getTime()).to.be.lessThanOrEqual(reportStart.getTime());
    });

    it('should not generate default dates when only one date in a period is undefined', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01', // reportStartDate provided
        undefined, // reportEndDate not provided
        '2024-12-01', // comparisonStartDate provided
        undefined, // comparisonEndDate not provided
      ];

      await command.handleExecution(args, slackContext);

      // Should not call the API because validation will fail
      expect(global.fetch).to.not.have.been.called;

      // Should show validation error messages
      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
    });

    it('should not generate default report period dates when reportStartDate is provided but reportEndDate is null', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01', // reportStartDate provided
        null, // reportEndDate is null (covers line 183)
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      // Should not call the API because validation will fail
      expect(global.fetch).to.not.have.been.called;

      // Should show validation error messages
      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
    });

    it('should not generate default comparison period dates when comparisonStartDate is provided but comparisonEndDate is null', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01', // comparisonStartDate provided
        null, // comparisonEndDate is null (covers line 193)
      ];

      await command.handleExecution(args, slackContext);

      // Should not call the API because validation will fail
      expect(global.fetch).to.not.have.been.called;

      // Should show validation error messages
      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
    });

    it('should not generate default report period dates when reportStartDate is undefined but reportEndDate is provided', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        undefined, // reportStartDate is undefined (covers line 183)
        '2025-01-31', // reportEndDate provided
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      // Should not call the API because validation will fail
      expect(global.fetch).to.not.have.been.called;

      // Should show validation error messages
      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
    });

    it('should not generate default comparison period dates when comparisonStartDate is undefined but comparisonEndDate is provided', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        undefined, // comparisonStartDate is undefined (covers line 193)
        '2024-12-31', // comparisonEndDate provided
      ];

      await command.handleExecution(args, slackContext);

      // Should not call the API because validation will fail
      expect(global.fetch).to.not.have.been.called;

      // Should show validation error messages
      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
    });
  });

  describe('Handle Execution Method', () => {
    it('should execute successfully with valid arguments', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(global.fetch).to.have.been.calledOnce;

      const fetchCall = global.fetch.firstCall;
      expect(fetchCall.args[0]).to.equal('https://api.spacecat.com/sites/123e4567-e89b-12d3-a456-426614174000/reports');
      expect(fetchCall.args[1].method).to.equal('POST');
      expect(fetchCall.args[1].headers['Content-Type']).to.equal('application/json');
      expect(fetchCall.args[1].headers['x-api-key']).to.equal('test-api-key');

      const requestBody = JSON.parse(fetchCall.args[1].body);
      expect(requestBody).to.deep.equal({
        reportType: 'performance',
        name: 'Test report',
        reportPeriod: {
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        },
        comparisonPeriod: {
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        },
      });

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':white_check_mark: Report generation job queued successfully!');
    });

    it('should handle optimization report type', async () => {
      const mockApiResponse = {
        reportId: 'report-456',
        status: 'queued',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'optimization',
        'Optimization Report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      const fetchCall = global.fetch.firstCall;
      const requestBody = JSON.parse(fetchCall.args[1].body);
      expect(requestBody.reportType).to.equal('optimization');
    });

    it('should return error for missing required arguments', async () => {
      const command = RunReportCommand(context);
      const testCases = [
        ['https://example.com'], // Missing reportType
        [undefined, 'performance'], // Missing site
        [null, 'performance'], // Missing site
      ];

      for (const args of testCases) {
        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        expect(slackContext.say).to.have.been.calledOnce;
        expect(slackContext.say.firstCall.args[0]).to.include(':warning: Missing required arguments.');

        // Reset for next iteration
        slackContext.say.resetHistory();
      }
    });

    it('should return error for invalid site URL', async () => {
      const command = RunReportCommand(context);
      const args = [
        'invalid-url',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Invalid site URL: invalid-url');
    });

    it('should return error for site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunReportCommand(context);
      const args = [
        'https://nonexistent.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Site not found: https://nonexistent.com');
    });

    it('should return error for invalid report type', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'invalid-type',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Invalid report type: invalid-type');
      expect(slackContext.say.firstCall.args[0]).to.include('Valid types are: `optimization`, `performance`');
    });

    it('should handle API request failure', async () => {
      global.fetch.resolves({
        ok: false,
        status: 400,
        text: sinon.stub().resolves('Bad Request'),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report');
      expect(slackContext.say.secondCall.args[0]).to.include(':nuclear-warning: Oops! Something went wrong');
    });

    it('should handle fetch network error', async () => {
      global.fetch.rejects(new Error('Network error'));

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report');
      expect(slackContext.say.secondCall.args[0]).to.include(':nuclear-warning: Oops! Something went wrong');
    });

    it('should work without API key when USER_API_KEY is not set', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      // Remove API key from environment
      const contextWithoutApiKey = {
        ...context,
        env: {
          ...context.env,
          USER_API_KEY: undefined,
        },
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(contextWithoutApiKey);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      const fetchCall = global.fetch.firstCall;
      expect(fetchCall.args[1].headers).to.not.have.property('x-api-key');
    });

    it('should handle missing report ID in API response', async () => {
      const mockApiResponse = {
        status: 'processing',
        // No reportId field
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.secondCall.args[0]).to.include('• Report ID: N/A');
    });

    it('should handle missing status in API response', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        // No status field
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.secondCall.args[0]).to.include('• Status: processing');
    });
  });

  describe('Edge Cases', () => {
    it('should handle leap year dates correctly', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Leap Year Report',
        '2024-02-29', // Leap year date
        '2024-02-29',
        '2023-02-28',
        '2023-02-28',
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledTwice;
    });

    it('should handle year boundary dates', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Year Boundary Report',
        '2024-12-31',
        '2025-01-01',
        '2023-12-31',
        '2024-01-01',
      ];

      await command.handleExecution(args, slackContext);

      expect(global.fetch).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledTwice;
    });

    it('should handle various URL formats', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const urlFormats = [
        'https://example.com',
        'http://example.com',
        'https://www.example.com',
        'https://subdomain.example.com',
        'https://example.com/path',
        'https://example.com:8080',
      ];

      for (const url of urlFormats) {
        const args = [
          url,
          'performance',
          'Test report',
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        expect(global.fetch).to.have.been.calledOnce;
        expect(dataAccessStub.Site.findByBaseURL).to.have.been.called;

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
        dataAccessStub.Site.findByBaseURL.resetHistory();
      }
    });

    it('should handle database errors gracefully', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Database connection failed'));

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':nuclear-warning: Oops! Something went wrong');
    });

    it('should handle JSON parsing errors in API response', async () => {
      global.fetch.resolves({
        ok: true,
        json: sinon.stub().rejects(new Error('Invalid JSON')),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.secondCall.args[0]).to.include(':nuclear-warning: Oops! Something went wrong');
    });
  });

  describe('URL Extraction and Validation', () => {
    it('should handle various URL input formats', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const urlInputs = [
        'https://example.com',
        'http://example.com',
        'example.com', // Without protocol
        'www.example.com', // Without protocol
        'https://www.example.com/path/to/page',
        'https://subdomain.example.com:8080/path',
      ];

      for (const urlInput of urlInputs) {
        const args = [
          urlInput,
          'performance',
          'Test report',
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(args, slackContext);

        expect(global.fetch).to.have.been.calledOnce;

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
      }
    });
  });

  describe('Success Message Formatting', () => {
    it('should format success message with all details', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'queued',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Monthly Report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      const successMessage = slackContext.say.secondCall.args[0];
      expect(successMessage).to.include(':white_check_mark: Report generation job queued successfully!');
      expect(successMessage).to.include('• Site: https://example.com');
      expect(successMessage).to.include('• Report Type: performance');
      expect(successMessage).to.include('• Report Name: Monthly report');
      expect(successMessage).to.include('• Report Period: 2025-01-01 to 2025-01-31');
      expect(successMessage).to.include('• Comparison Period: 2024-12-01 to 2024-12-31');
      expect(successMessage).to.include('• Report ID: report-123');
      expect(successMessage).to.include('• Status: queued');
    });
  });
});
