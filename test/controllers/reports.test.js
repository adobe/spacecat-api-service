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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';

import ReportsController from '../../src/controllers/reports.js';

use(sinonChai);
use(chaiAsPromised);

describe('ReportsController', () => {
  let reportsController;
  let mockContext;
  let mockLog;
  let mockEnv;
  let mockDataAccess;
  let mockSqs;
  let mockSite;
  let mockAccessControlUtil;

  describe('constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => ReportsController(null, mockLog, mockEnv)).to.throw('Context required');
    });

    it('should throw error when context is not an object', () => {
      expect(() => ReportsController('not-an-object', mockLog, mockEnv)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => ReportsController({}, mockLog, mockEnv)).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      const contextWithoutDataAccess = {
        sqs: mockSqs,
      };
      expect(() => ReportsController(contextWithoutDataAccess, mockLog, mockEnv)).to.throw('Data access required');
    });

    it('should throw error when dataAccess is not an object', () => {
      const contextWithInvalidDataAccess = {
        dataAccess: 'not-an-object',
        sqs: mockSqs,
      };
      expect(() => ReportsController(contextWithInvalidDataAccess, mockLog, mockEnv)).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      const contextWithEmptyDataAccess = {
        dataAccess: {},
        sqs: mockSqs,
      };
      expect(() => ReportsController(contextWithEmptyDataAccess, mockLog, mockEnv)).to.throw('Data access required');
    });

    it('should not throw error when valid context is provided', () => {
      expect(() => ReportsController(mockContext, mockLog, mockEnv)).to.not.throw();
    });
  });

  beforeEach(async () => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    mockEnv = {
      REPORT_JOBS_QUEUE_URL: 'https://sqs.test.com/report-jobs-queue',
    };

    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
    };

    mockDataAccess = {
      Site: {
        findById: sinon.stub().resolves(mockSite),
      },
      Report: {
        create: sinon.stub().resolves({
          getId: () => 'test-report-id',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'performance',
          getReportPeriod: () => ({
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          }),
          getComparisonPeriod: () => ({
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          }),
        }),
        allBySiteId: sinon.stub().resolves([]), // No existing reports by default
      },
    };

    mockSqs = {
      sendMessage: sinon.stub().resolves(),
    };

    mockAccessControlUtil = {
      hasAccess: sinon.stub().resolves(true),
    };

    mockContext = {
      dataAccess: mockDataAccess,
      sqs: mockSqs,
      attributes: {
        user: {
          email: 'test@example.com',
        },
      },
    };

    // Mock the AccessControlUtil.fromContext method
    const AccessControlUtil = await import('../../src/support/access-control-util.js');
    sinon.stub(AccessControlUtil.default, 'fromContext').returns(mockAccessControlUtil);

    reportsController = ReportsController(mockContext, mockLog, mockEnv);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createReport', () => {
    it('should successfully create a report job', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        message: 'Report generation job queued successfully',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportType: 'performance',
        status: 'queued',
      });
      expect(responseBody.jobId).to.be.a('string');
      expect(responseBody.jobId).to.equal('test-report-id');

      expect(mockSqs.sendMessage).to.have.been.calledOnceWith(
        mockEnv.REPORT_JOBS_QUEUE_URL,
        sinon.match({
          jobId: 'test-report-id',
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
          initiatedBy: 'test@example.com',
        }),
      );
    });

    it('should return bad request for duplicate report with same parameters', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      // Mock existing report with same parameters
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('A report with the same type and duration already exists for this site');
    });

    it('should not return duplicate error when existing reports have different report type', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      // Mock existing report with DIFFERENT report type but same periods
      const existingReport = {
        getReportType: () => 'optimization', // Different type
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      // Reset other mocks for successful creation
      mockDataAccess.Site.findById.resolves(mockSite);
      mockAccessControlUtil.hasAccess.resolves(true);
      mockDataAccess.Report.create.resolves({
        getId: () => 'test-report-id',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
      });
      mockSqs.sendMessage.resolves();

      const result = await reportsController.createReport(context);

      // Should succeed since report types are different
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
      expect(responseBody.reportType).to.equal('performance');
    });

    it('should successfully create report when existing report has different type (explicit branch test)', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'security', // Different from existing
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      // Mock existing report with different report type
      const existingReportWithDifferentType = {
        getReportType: () => 'cwv', // Different from 'security'
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReportWithDifferentType]);

      // Reset other mocks for successful creation
      mockDataAccess.Site.findById.resolves(mockSite);
      mockAccessControlUtil.hasAccess.resolves(true);
      mockDataAccess.Report.create.resolves({
        getId: () => 'test-security-report-id',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        getReportType: () => 'security',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
      });
      mockSqs.sendMessage.resolves();

      const result = await reportsController.createReport(context);

      // Should succeed since report types are different
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
      expect(responseBody.reportType).to.equal('security');
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: {
          siteId: 'invalid-uuid',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid site ID is required');
    });

    it('should return bad request for missing report type', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: '',
          test: 'data',
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report type is required');
    });

    it('should return bad request for missing report period', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report period is required');
    });

    it('should return bad request for missing report period start date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report period start date is required');
    });

    it('should return bad request for missing report period end date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report period end date is required');
    });

    it('should return bad request for missing comparison period', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period is required');
    });

    it('should return bad request for missing comparison period start date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period start date is required');
    });

    it('should return bad request for missing comparison period end date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period end date is required');
    });

    it('should return bad request for missing data', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: null,
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Request data is required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('User does not have access to this site');
    });

    it('should return internal server error when queue URL is not configured', async () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {};

      const controllerWithoutQueue = ReportsController(
        contextWithNoQueue,
        mockLog,
        envWithoutQueue,
      );

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await controllerWithoutQueue.createReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Reports queue is not configured');
    });

    it('should return internal server error when SQS send fails', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to create report job: SQS error');
    });

    it('should use unknown for initiatedBy when user email is not available', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          },
        },
        attributes: {},
      };

      await reportsController.createReport(context);

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        mockEnv.REPORT_JOBS_QUEUE_URL,
        sinon.match({
          initiatedBy: 'unknown',
        }),
      );
    });
  });

  describe('getAllReportsBySiteId', () => {
    it('should successfully get all reports for a site', async () => {
      const mockReports = [
        {
          getId: () => 'report-1',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'performance',
          getReportPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getComparisonPeriod: () => ({ startDate: '2024-12-01', endDate: '2024-12-31' }),
          getStoragePath: () => '/reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/',
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
        },
        {
          getId: () => 'report-2',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'optimization',
          getReportPeriod: () => ({ startDate: '2025-02-01', endDate: '2025-02-28' }),
          getComparisonPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getStoragePath: () => '/reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/',
          getCreatedAt: () => '2025-02-15T10:00:00Z',
          getUpdatedAt: () => '2025-02-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
        },
      ];

      mockDataAccess.Report.allBySiteId.resolves(mockReports);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        count: 2,
      });
      expect(responseBody.reports).to.be.an('array');
      expect(responseBody.reports).to.have.length(2);
      expect(responseBody.reports[0]).to.deep.include({
        id: 'report-1',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportType: 'performance',
      });
      expect(responseBody.reports[1]).to.deep.include({
        id: 'report-2',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportType: 'optimization',
      });

      expect(mockDataAccess.Report.allBySiteId).to.have.been.calledOnceWith('123e4567-e89b-12d3-a456-426614174000');
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: {
          siteId: 'invalid-uuid',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid site ID is required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('User does not have access to this site');
    });

    it('should return empty array when no reports exist for site', async () => {
      mockDataAccess.Report.allBySiteId.resolves([]);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        count: 0,
      });
      expect(responseBody.reports).to.be.an('array');
      expect(responseBody.reports).to.have.length(0);
    });

    it('should return internal server error when database operation fails', async () => {
      mockDataAccess.Report.allBySiteId.rejects(new Error('Database error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to get reports: Database error');
    });
  });

  describe('getReport', () => {
    let mockReport;

    beforeEach(() => {
      mockReport = {
        getId: () => '987e6543-e21b-12d3-a456-426614174001',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        getReportType: () => 'performance',
        getReportPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
        getComparisonPeriod: () => ({ startDate: '2024-12-01', endDate: '2024-12-31' }),
        getStoragePath: () => '/reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:30:00Z',
        getUpdatedBy: () => 'test@example.com',
      };

      mockDataAccess.Report.findById = sinon.stub().resolves(mockReport);
    });

    it('should successfully retrieve a specific report', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        id: '987e6543-e21b-12d3-a456-426614174001',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportType: 'performance',
      });

      expect(mockDataAccess.Report.findById).to.have.been.calledOnceWith('987e6543-e21b-12d3-a456-426614174001');
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: {
          siteId: 'invalid-uuid',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid site ID is required');
    });

    it('should return bad request for invalid report ID', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: 'invalid-uuid',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid report ID is required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('User does not have access to this site');
    });

    it('should return not found for non-existent report', async () => {
      mockDataAccess.Report.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174002',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report not found');
    });

    it('should return bad request when report does not belong to site', async () => {
      const mockReportFromDifferentSite = {
        ...mockReport,
        getSiteId: () => '456e7890-e12b-34d5-a678-901234567890',
      };
      mockDataAccess.Report.findById.resolves(mockReportFromDifferentSite);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report does not belong to the specified site');
    });

    it('should return internal server error when database operation fails', async () => {
      mockDataAccess.Report.findById.rejects(new Error('Database error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to get report: Database error');
    });
  });

  describe('deleteReport', () => {
    let mockReport;

    beforeEach(() => {
      mockReport = {
        getId: () => '987e6543-e21b-12d3-a456-426614174001',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        remove: sinon.stub().resolves(),
      };

      mockDataAccess.Report.findById = sinon.stub().resolves(mockReport);
    });

    it('should successfully delete a specific report', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        message: 'Report deleted successfully',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportId: '987e6543-e21b-12d3-a456-426614174001',
      });

      expect(mockDataAccess.Report.findById).to.have.been.calledOnceWith('987e6543-e21b-12d3-a456-426614174001');
      expect(mockReport.remove).to.have.been.calledOnce;
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: {
          siteId: 'invalid-uuid',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid site ID is required');
    });

    it('should return bad request for invalid report ID', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: 'invalid-uuid',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid report ID is required');
    });

    it('should return not found for non-existent site', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('User does not have access to this site');
    });

    it('should return not found for non-existent report', async () => {
      mockDataAccess.Report.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174002',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report not found');
    });

    it('should return bad request when report does not belong to site', async () => {
      const mockReportFromDifferentSite = {
        ...mockReport,
        getSiteId: () => '456e7890-e12b-34d5-a678-901234567890',
      };
      mockDataAccess.Report.findById.resolves(mockReportFromDifferentSite);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report does not belong to the specified site');
    });

    it('should return internal server error when deletion fails', async () => {
      mockReport.remove.rejects(new Error('Deletion failed'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to delete report: Deletion failed');
    });

    it('should return internal server error when database operation fails', async () => {
      mockDataAccess.Report.findById.rejects(new Error('Database error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to delete report: Database error');
    });
  });
});
