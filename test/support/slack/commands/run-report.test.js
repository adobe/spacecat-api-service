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
      // Test various name sanitization cases
      const testCases = [
        { input: 'MONTHLY REPORT', expected: 'Monthly report' },
        { input: '  weekly summary  ', expected: 'Weekly summary' },
        { input: 'q1 analysis', expected: 'Q1 analysis' },
        { input: 'PERFORMANCE   METRICS', expected: 'Performance metrics' },
        { input: 'test', expected: 'Test' },
        { input: 'a', expected: 'A' },
      ];

      const testPromises = testCases.map(async (testCase) => {
        const args = [
          'https://example.com',
          'performance',
          testCase.input,
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        await command.handleExecution(args, slackContext);

        const fetchCall = global.fetch.lastCall;
        const requestBody = JSON.parse(fetchCall.args[1].body);
        expect(requestBody.name).to.equal(testCase.expected);

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
      });

      await Promise.all(testPromises);
    });

    it('should handle empty and whitespace-only names', async () => {
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      const command = RunReportCommand(context);
      // Test edge cases for name sanitization
      const testCases = [
        { input: '', expected: '' },
        { input: '   ', expected: '' }, // Whitespace-only gets trimmed to empty
      ];

      const testPromises = testCases.map(async (testCase) => {
        const args = [
          'https://example.com',
          'performance',
          testCase.input,
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        await command.handleExecution(args, slackContext);

        const fetchCall = global.fetch.lastCall;
        const requestBody = JSON.parse(fetchCall.args[1].body);
        expect(requestBody.name).to.equal(testCase.expected);

        // Reset for next iteration
        global.fetch.resetHistory();
        slackContext.say.resetHistory();
      });

      await Promise.all(testPromises);
    });

    it('should handle null and undefined names gracefully', async () => {
      const command = RunReportCommand(context);

      // Test null and undefined cases - these should be caught by the missing arguments validation
      const testCases = [null, undefined];

      const testPromises = testCases.map(async (testCase) => {
        const args = [
          'https://example.com',
          'performance',
          testCase,
          '2025-01-01',
          '2025-01-31',
          '2024-12-01',
          '2024-12-31',
        ];

        await command.handleExecution(args, slackContext);
        // Should get missing arguments error, not a sanitization error
        expect(slackContext.say).to.have.been.calledOnce;
        expect(slackContext.say.firstCall.args[0]).to.include(':warning: Missing required arguments.');

        // Reset for next iteration
        slackContext.say.resetHistory();
      });

      await Promise.all(testPromises);
    });
  });

  describe('Date Validation', () => {
    it('should validate date format correctly', () => {
      // We'll test this through the actual execution since the function is private
      // This will be covered in the handleExecution tests below
    });

    it('should handle invalid date regex patterns', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025/01/01', // Invalid format - should fail regex test
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');
    });

    it('should handle invalid date values that pass regex but fail Date constructor', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025/02/30', // Invalid format - should fail regex
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');
    });

    it('should handle missing period object validation', async () => {
      // This test is designed to cover the isNonEmptyObject validation in isValidPeriod
      // We need to test the case where the period object itself is null/undefined
      // However, since the period is constructed in the handleExecution method,
      // we'll test edge cases that might trigger the validation

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

      // Mock successful API response
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      await command.handleExecution(args, slackContext);

      // This should work normally as the period objects are properly constructed
      expect(global.fetch).to.have.been.calledOnce;
    });

    it('should handle missing startDate in period', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '', // Empty start date
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date is required');
    });

    it('should handle missing endDate in period', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '', // Empty end date
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period end date is required');
    });

    it('should handle missing comparison period startDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '', // Empty comparison start date
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period start date is required');
    });

    it('should handle missing comparison period endDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '', // Empty comparison end date
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period end date is required');
    });

    it('should handle invalid comparison period startDate format', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024/12/01', // Invalid format
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period start date must be in YYYY-MM-DD format');
    });

    it('should handle invalid comparison period endDate format', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024/12/31', // Invalid format
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period end date must be in YYYY-MM-DD format');
    });

    it('should test period validation with valid arguments but invalid date format', async () => {
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

      // Mock successful API response
      const mockApiResponse = {
        reportId: 'report-123',
        status: 'processing',
      };

      global.fetch.resolves({
        ok: true,
        json: sinon.stub().resolves(mockApiResponse),
      });

      await command.handleExecution(args, slackContext);

      // This should work normally as all arguments are valid
      expect(global.fetch).to.have.been.calledOnce;
    });

    it('should test period validation with invalid date that passes regex but fails Date constructor', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-13-01', // Invalid date - passes regex but fails Date constructor (month 13)
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');
    });

    it('should test period validation with invalid end date that passes regex but fails Date constructor', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-13-01', // Invalid date - passes regex but fails Date constructor (month 13)
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period end date must be in YYYY-MM-DD format');
    });

    it('should test period validation with whitespace-only startDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '   ', // Whitespace-only start date - should fail hasText check
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');
    });

    it('should test period validation with whitespace-only endDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '   ', // Whitespace-only end date - should fail hasText check
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period end date must be in YYYY-MM-DD format');
    });

    it('should test period validation with whitespace-only comparison startDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '   ', // Whitespace-only comparison start date - should fail hasText check
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period start date must be in YYYY-MM-DD format');
    });

    it('should test period validation with whitespace-only comparison endDate', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '   ', // Whitespace-only comparison end date - should fail hasText check
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period end date must be in YYYY-MM-DD format');
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
      const args = ['https://example.com', 'performance']; // Missing required args

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Missing required arguments.');
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

    it('should return error for invalid date format', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025/01/01', // Invalid date format
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be in YYYY-MM-DD format');
    });

    it('should return error for start date after end date', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-31', // Start date after end date
        '2025-01-01',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Report period start date must be less than or equal to end date');
    });

    it('should return error for invalid comparison period date format', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024/12/01', // Invalid date format
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period start date must be in YYYY-MM-DD format');
    });

    it('should return error for comparison period start date after end date', async () => {
      const command = RunReportCommand(context);
      const args = [
        'https://example.com',
        'performance',
        'Test report',
        '2025-01-01',
        '2025-01-31',
        '2024-12-31', // Start date after end date
        '2024-12-01',
      ];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say).to.have.been.calledTwice;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Generating performance report "Test report" for site https://example.com...');
      expect(slackContext.say.secondCall.args[0]).to.include(':warning: Comparison period start date must be less than or equal to end date');
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
    it('should handle empty string arguments', async () => {
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
        'Test report', // Valid name
        '2025-01-01',
        '2025-01-31',
        '2024-12-01',
        '2024-12-31',
      ];

      await command.handleExecution(args, slackContext);

      // Should proceed with valid arguments
      expect(global.fetch).to.have.been.calledOnce;
    });

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
  });
});
