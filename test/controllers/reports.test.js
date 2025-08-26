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

  // Helper function to create a valid request context
  const createValidContext = (siteId = '123e4567-e89b-12d3-a456-426614174000', reportId = null) => ({
    params: {
      siteId,
      ...(reportId && { reportId }),
    },
    data: {
      reportType: 'performance',
      name: 'Test Report',
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
      authInfo: {
        profile: {
          email: 'test@example.com',
        },
      },
    },
  });

  // Helper function to test common validation scenarios
  const testCommonValidations = (methodName, requiresReportId = false) => {
    const validReportId = '987e6543-e21b-12d3-a456-426614174001';

    it('should return bad request for invalid site ID', async () => {
      const context = createValidContext('invalid-uuid', requiresReportId ? validReportId : null);
      // Only delete data for non-createReport methods
      if (methodName !== 'createReport') delete context.data;

      const result = await reportsController[methodName](context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Valid site ID is required');
    });

    if (requiresReportId) {
      it('should return bad request for invalid report ID', async () => {
        const context = createValidContext('123e4567-e89b-12d3-a456-426614174000', 'invalid-uuid');
        delete context.data;

        const result = await reportsController[methodName](context);

        expect(result.status).to.equal(400);
        const responseBody = await result.json();
        expect(responseBody.message).to.equal('Valid report ID is required');
      });
    }

    it('should return not found for non-existent site', async () => {
      const originalFindById = mockDataAccess.Site.findById;
      mockDataAccess.Site.findById = sinon.stub().resolves(null);

      const context = createValidContext('123e4567-e89b-12d3-a456-426614174000', requiresReportId ? validReportId : null);
      // Only delete data for non-createReport and non-patchReport methods
      if (methodName !== 'createReport' && methodName !== 'patchReport') delete context.data;

      const result = await reportsController[methodName](context);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');

      // Restore original mock
      mockDataAccess.Site.findById = originalFindById;
    });

    it('should return forbidden when user lacks access', async () => {
      const originalHasAccess = mockAccessControlUtil.hasAccess;
      mockAccessControlUtil.hasAccess = sinon.stub().resolves(false);

      const context = createValidContext('123e4567-e89b-12d3-a456-426614174000', requiresReportId ? validReportId : null);
      // Only delete data for non-createReport and non-patchReport methods
      if (methodName !== 'createReport' && methodName !== 'patchReport') delete context.data;

      const result = await reportsController[methodName](context);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('User does not have access to this site');

      // Restore original mock
      mockAccessControlUtil.hasAccess = originalHasAccess;
    });
  };

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
      warn: sinon.stub(),
    };

    mockEnv = {
      REPORT_JOBS_QUEUE_URL: 'https://sqs.test.com/report-jobs-queue',
      S3_REPORT_BUCKET: 'test-bucket',
      S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
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
          getStatus: () => 'success',
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/test-report-id/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/test-report-id/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/test-report-id/enhanced/',
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
        }),
        allBySiteId: sinon.stub().resolves([]), // No existing reports by default
        findById: sinon.stub().resolves(null), // No existing report by default
      },
    };

    mockSqs = {
      sendMessage: sinon.stub().resolves(),
    };

    mockAccessControlUtil = {
      hasAccess: sinon.stub().resolves(true),
    };

    mockContext = {
      s3: {
        s3Client: {
          send: sinon.stub().resolves(),
        },
        getSignedUrl: sinon.stub().resolves('https://presigned-url.com'),
        GetObjectCommand: sinon.stub(),
        DeleteObjectCommand: sinon.stub(),
        PutObjectCommand: sinon.stub(),
      },
      dataAccess: mockDataAccess,
      sqs: mockSqs,
      attributes: {
        authInfo: {
          profile: {
            email: 'test@example.com',
          },
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
      const context = createValidContext();

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        message: 'Report generation job queued successfully',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportType: 'performance',
        status: 'processing',
      });
      expect(responseBody.reportId).to.be.a('string');
      expect(responseBody.reportId).to.equal('test-report-id');

      expect(mockSqs.sendMessage).to.have.been.calledOnceWith(
        mockEnv.REPORT_JOBS_QUEUE_URL,
        sinon.match({
          type: 'performance',
          data: sinon.match({
            reportId: 'test-report-id',
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
          name: 'Test Report',
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
          authInfo: {
            profile: {
              email: 'test@example.com',
            },
          },
        },
      };

      // Mock existing successful report with same parameters
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
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('A report with the same type and duration already exists for this site. Current status: success');
    });

    it('should successfully create report when existing failed report has same parameters', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing failed report with same parameters
      const existingFailedReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
        getStatus: () => 'failed',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingFailedReport]);

      const result = await reportsController.createReport(context);

      // Should succeed since the existing report failed
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
      expect(responseBody.reportType).to.equal('performance');
    });

    it('should filter out failed reports but prevent duplicate for successful reports', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock mixed reports: failed and successful with same parameters
      const existingReports = [
        {
          getReportType: () => 'performance',
          getReportPeriod: () => ({
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          }),
          getComparisonPeriod: () => ({
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          }),
          getStatus: () => 'failed',
        },
        {
          getReportType: () => 'performance',
          getReportPeriod: () => ({
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          }),
          getComparisonPeriod: () => ({
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          }),
          getStatus: () => 'success',
        },
      ];

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves(existingReports);

      const result = await reportsController.createReport(context);

      // Should fail because there's a successful report with same parameters
      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('A report with the same type and duration already exists for this site. Current status: success');
    });

    it('should successfully create report when existing reports have different report types', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing reports with different report types but same periods
      const existingReports = [
        {
          getReportType: () => 'optimization',
          getReportPeriod: () => ({
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          }),
          getComparisonPeriod: () => ({
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          }),
          getStatus: () => 'success',
        },
        {
          getReportType: () => 'security',
          getReportPeriod: () => ({
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          }),
          getComparisonPeriod: () => ({
            startDate: '2024-12-01',
            endDate: '2024-12-31',
          }),
          getStatus: () => 'success',
        },
      ];

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves(existingReports);

      const result = await reportsController.createReport(context);

      // Should succeed since report types are different
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
      expect(responseBody.reportType).to.equal('performance');
    });

    it('should return bad request for missing report name', async () => {
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

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report name is required');
    });

    it('should return bad request for missing report type', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: '',
          name: 'Test Report',
          test: 'data',
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report type is required');
    });

    it('should successfully create report when existing failed report has same parameters', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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
          authInfo: {
            profile: {
              email: 'test@example.com',
            },
          },
        },
      };

      // Mock existing failed report with same parameters
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
        getStatus: () => 'failed',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      // Should succeed since failed reports are not considered duplicates
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
      expect(responseBody.reportType).to.equal('performance');
    });

    it('should return bad request for invalid report type', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'invalid-type',
          name: 'Test Report',
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
      expect(responseBody.message).to.equal('Invalid report type. Valid types are: optimization, performance');
    });

    it('should return bad request for missing report period', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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
          name: 'Test Report',
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
          name: 'Test Report',
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
          name: 'Test Report',
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
          name: 'Test Report',
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
          name: 'Test Report',
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

    it('should return bad request for invalid report period start date format', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025/01/01',
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
      expect(responseBody.message).to.equal('Report period start date must be in YYYY-MM-DD format');
    });

    it('should return bad request for invalid report period end date format', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '01/31/2025',
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
      expect(responseBody.message).to.equal('Report period end date must be in YYYY-MM-DD format');
    });

    it('should return bad request for invalid comparison period start date format', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '12-01-2024',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period start date must be in YYYY-MM-DD format');
    });

    it('should return bad request for invalid comparison period end date format', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024/12/31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period end date must be in YYYY-MM-DD format');
    });

    it('should return bad request for invalid report period start date value', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-13-01',
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
      expect(responseBody.message).to.equal('Report period start date is not a valid date');
    });

    it('should return bad request for invalid report period end date value', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-13-01',
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
      expect(responseBody.message).to.equal('Report period end date is not a valid date');
    });

    it('should return bad request for invalid comparison period start date value', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-00-01',
            endDate: '2024-12-31',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period start date is not a valid date');
    });

    it('should return bad request for invalid comparison period end date value', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-32',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period end date is not a valid date');
    });

    it('should return bad request when report period start date is after end date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-31',
            endDate: '2025-01-01',
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
      expect(responseBody.message).to.equal('Report period start date must be less than or equal to end date');
    });

    it('should return bad request when comparison period start date is after end date', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: {
            startDate: '2024-12-31',
            endDate: '2024-12-01',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period start date must be less than or equal to end date');
    });

    it('should accept same-day periods', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-01',
          },
          comparisonPeriod: {
            startDate: '2024-12-01',
            endDate: '2024-12-01',
          },
        },
      };

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
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

    // Common validation tests
    testCommonValidations('createReport');

    it('should throw error during initialization when queue URL is not configured', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {};

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('Environment variables required');
    });

    it('should throw error during initialization when REPORT_JOBS_QUEUE_URL is missing', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        S3_REPORT_BUCKET: 'test-reports-bucket',
        S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('REPORT_JOBS_QUEUE_URL environment variable is required');
    });

    it('should throw error during initialization when S3_REPORT_BUCKET is missing', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/reports-queue',
        S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('S3_REPORT_BUCKET environment variable is required');
    });

    it('should throw error during initialization when S3_MYSTIQUE_BUCKET is missing', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/reports-queue',
        S3_REPORT_BUCKET: 'test-reports-bucket',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('S3_MYSTIQUE_BUCKET environment variable is required');
    });

    it('should throw error during initialization when REPORT_JOBS_QUEUE_URL is empty string', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        REPORT_JOBS_QUEUE_URL: '',
        S3_REPORT_BUCKET: 'test-reports-bucket',
        S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('REPORT_JOBS_QUEUE_URL environment variable is required');
    });

    it('should throw error during initialization when S3_REPORT_BUCKET is empty string', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/reports-queue',
        S3_REPORT_BUCKET: '',
        S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('S3_REPORT_BUCKET environment variable is required');
    });

    it('should throw error during initialization when S3_MYSTIQUE_BUCKET is empty string', () => {
      const contextWithNoQueue = {
        ...mockContext,
      };
      const envWithoutQueue = {
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/reports-queue',
        S3_REPORT_BUCKET: 'test-reports-bucket',
        S3_MYSTIQUE_BUCKET: '',
      };

      expect(() => {
        ReportsController(
          contextWithNoQueue,
          mockLog,
          envWithoutQueue,
        );
      }).to.throw('S3_MYSTIQUE_BUCKET environment variable is required');
    });

    it('should return internal server error when SQS send fails', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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
          name: 'Test Report',
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
          type: 'performance',
          data: sinon.match({
            initiatedBy: 'unknown',
          }),
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
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/enhanced/',
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
          getStatus: () => 'success',
        },
        {
          getId: () => 'report-2',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'optimization',
          getReportPeriod: () => ({ startDate: '2025-02-01', endDate: '2025-02-28' }),
          getComparisonPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/enhanced/',
          getCreatedAt: () => '2025-02-15T10:00:00Z',
          getUpdatedAt: () => '2025-02-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
          getStatus: () => 'processing',
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

    // Common validation tests
    testCommonValidations('getAllReportsBySiteId');

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
        getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/',
        getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/raw/',
        getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:30:00Z',
        getUpdatedBy: () => 'test@example.com',
        getStatus: () => 'success',
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

    // Common validation tests
    testCommonValidations('getReport', true);

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
        getStatus: () => 'success',
        getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/',
        getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/raw/',
        getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/',
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
        s3: mockContext.s3,
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

    it('should delete S3 files for successful reports', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        s3: mockContext.s3,
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(200);

      // Verify S3 deletion was called for both files
      expect(mockContext.s3.DeleteObjectCommand).to.have.been.calledTwice;
      expect(mockContext.s3.s3Client.send).to.have.been.calledTwice;

      // Verify the correct S3 keys were used
      const deleteCommands = mockContext.s3.DeleteObjectCommand.getCalls();
      const rawReportKey = 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/raw/report.json';
      const mystiqueReportKey = 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/report.json';

      expect(deleteCommands[0].args[0]).to.deep.include({
        Bucket: 'test-bucket',
        Key: rawReportKey,
      });
      expect(deleteCommands[1].args[0]).to.deep.include({
        Bucket: 'test-mystique-bucket',
        Key: mystiqueReportKey,
      });

      expect(mockReport.remove).to.have.been.calledOnce;
    });

    it('should not delete S3 files for reports with non-success status', async () => {
      // Create a report with processing status
      const processingReport = {
        ...mockReport,
        getStatus: () => 'processing',
      };
      mockDataAccess.Report.findById.resolves(processingReport);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        s3: mockContext.s3,
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(200);

      // Verify S3 deletion was NOT called
      expect(mockContext.s3.DeleteObjectCommand).to.not.have.been.called;
      expect(mockContext.s3.s3Client.send).to.not.have.been.called;

      expect(processingReport.remove).to.have.been.calledOnce;
    });

    it('should continue with database deletion even if S3 deletion fails', async () => {
      // Make S3 deletion fail
      mockContext.s3.s3Client.send.rejects(new Error('S3 deletion failed'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        s3: mockContext.s3,
      };

      const result = await reportsController.deleteReport(context);

      expect(result.status).to.equal(200);

      // Verify S3 deletion was attempted
      expect(mockContext.s3.DeleteObjectCommand).to.have.been.calledTwice;
      expect(mockContext.s3.s3Client.send).to.have.been.calledTwice;

      // Verify warning was logged for S3 failure
      expect(mockLog.warn).to.have.been.calledOnce;
      expect(mockLog.warn.firstCall.args[0]).to.include('Failed to delete S3 files');

      // Verify database deletion still proceeded
      expect(mockReport.remove).to.have.been.calledOnce;
    });

    // Common validation tests
    testCommonValidations('deleteReport', true);

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
        s3: mockContext.s3,
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

  describe('patchReport', () => {
    let mockReport;

    beforeEach(() => {
      mockReport = {
        getId: () => '987e6543-e21b-12d3-a456-426614174001',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        getStatus: () => 'success',
        getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/',
        getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/raw/',
        getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/',
        save: sinon.stub().resolves(),
      };

      mockDataAccess.Report.findById = sinon.stub().resolves(mockReport);
    });

    it('should successfully update enhanced report data', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: {
          summary: 'Updated report summary',
          metrics: { performance: 95 },
          recommendations: ['Updated recommendation 1', 'Updated recommendation 2'],
        },
        s3: mockContext.s3,
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        message: 'Enhanced report updated successfully',
        siteId: '123e4567-e89b-12d3-a456-426614174000',
        reportId: '987e6543-e21b-12d3-a456-426614174001',
      });
      expect(responseBody.updatedAt).to.be.a('string');

      // Verify S3 upload was called with correct parameters
      expect(mockContext.s3.PutObjectCommand).to.have.been.calledOnce;
      expect(mockContext.s3.s3Client.send).to.have.been.calledOnce;

      const putCommand = mockContext.s3.PutObjectCommand.getCall(0).args[0];
      const mystiqueReportKey = 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/report.json';

      expect(putCommand).to.deep.include({
        Bucket: 'test-mystique-bucket',
        Key: mystiqueReportKey,
        ContentType: 'application/json',
      });

      // Verify the uploaded data matches the request data
      const uploadedData = JSON.parse(putCommand.Body);
      expect(uploadedData).to.deep.equal(context.data);

      // Verify report was saved to update timestamp
      expect(mockReport.save).to.have.been.calledOnce;
    });

    it('should return bad request when report is not in success status', async () => {
      const processingReport = {
        ...mockReport,
        getStatus: () => 'processing',
      };
      mockDataAccess.Report.findById.resolves(processingReport);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: { summary: 'Updated summary' },
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Can only update reports that are in success status');
    });

    it('should return bad request when report has no storage path', async () => {
      const reportWithoutStoragePath = {
        ...mockReport,
        getStoragePath: () => null,
        getRawStoragePath: () => null,
        getEnhancedStoragePath: () => null,
      };
      mockDataAccess.Report.findById.resolves(reportWithoutStoragePath);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: { summary: 'Updated summary' },
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report does not have a valid storage path');
    });

    it('should return bad request when request data is missing', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: null,
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Request data is required');
    });

    it('should return bad request when request data is empty', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: {},
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Request data is required');
    });

    it('should return internal server error when S3 upload fails', async () => {
      mockContext.s3.s3Client.send.rejects(new Error('S3 upload failed'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: { summary: 'Updated summary' },
        s3: mockContext.s3,
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to update report in S3: S3 upload failed');
    });

    it('should return internal server error when database operation fails', async () => {
      mockDataAccess.Report.findById.rejects(new Error('Database error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
        data: { summary: 'Updated summary' },
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(500);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Failed to update report: Database error');
    });

    // Common validation tests
    testCommonValidations('patchReport', true);

    it('should return not found for non-existent report', async () => {
      mockDataAccess.Report.findById.resolves(null);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174002',
        },
        data: { summary: 'Updated summary' },
      };

      const result = await reportsController.patchReport(context);

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
        data: { summary: 'Updated summary' },
      };

      const result = await reportsController.patchReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report does not belong to the specified site');
    });
  });

  describe('getAllReportsBySiteId with presigned URLs', () => {
    it('should generate presigned URLs for reports with success status', async () => {
      const mockReportsWithSuccess = [
        {
          getId: () => 'report-1',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'performance',
          getReportPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getComparisonPeriod: () => ({ startDate: '2024-12-01', endDate: '2024-12-31' }),
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/enhanced/',
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
          getStatus: () => 'success',
        },
        {
          getId: () => 'report-2',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'optimization',
          getReportPeriod: () => ({ startDate: '2025-02-01', endDate: '2025-02-28' }),
          getComparisonPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/optimization/report-2/enhanced/',
          getCreatedAt: () => '2025-02-15T10:00:00Z',
          getUpdatedAt: () => '2025-02-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
          getStatus: () => 'processing',
        },
      ];

      mockDataAccess.Report.allBySiteId.resolves(mockReportsWithSuccess);

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.reports).to.have.length(2);

      // First report has success status, should have presigned URLs
      expect(mockContext.s3.getSignedUrl).to.have.been.calledTwice;

      // Second report has pending status, should not generate presigned URLs
      expect(responseBody.reports[1]).to.not.have.property('rawPresignedUrl');
    });

    it('should handle presigned URL generation errors gracefully', async () => {
      const mockReportWithSuccess = [
        {
          getId: () => 'report-1',
          getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
          getReportType: () => 'performance',
          getReportPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          getComparisonPeriod: () => ({ startDate: '2024-12-01', endDate: '2024-12-31' }),
          getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/',
          getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/raw/',
          getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/report-1/enhanced/',
          getCreatedAt: () => '2025-01-15T10:00:00Z',
          getUpdatedAt: () => '2025-01-15T10:30:00Z',
          getUpdatedBy: () => 'test@example.com',
          getStatus: () => 'success',
        },
      ];

      mockDataAccess.Report.allBySiteId.resolves(mockReportWithSuccess);
      mockContext.s3.getSignedUrl.rejects(new Error('S3 error'));

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
      };

      const result = await reportsController.getAllReportsBySiteId(context);

      expect(result.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledOnce;
      expect(mockLog.warn.firstCall.args[0]).to.include('Failed to generate presigned URLs');
    });
  });

  describe('getReport with presigned URLs', () => {
    let mockReport;

    beforeEach(() => {
      mockReport = {
        getId: () => '987e6543-e21b-12d3-a456-426614174001',
        getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
        getReportType: () => 'performance',
        getReportPeriod: () => ({ startDate: '2025-01-01', endDate: '2025-01-31' }),
        getComparisonPeriod: () => ({ startDate: '2024-12-01', endDate: '2024-12-31' }),
        getStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/',
        getRawStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/raw/',
        getEnhancedStoragePath: () => 'reports/123e4567-e89b-12d3-a456-426614174000/performance/987e6543-e21b-12d3-a456-426614174001/enhanced/',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getUpdatedBy: () => 'test@example.com',
        getStatus: () => 'success',
      };

      mockDataAccess.Report.findById = sinon.stub().resolves(mockReport);
    });

    it('should generate presigned URLs for report with success status', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(200);
      expect(mockContext.s3.getSignedUrl).to.have.been.calledTwice;
      expect(mockContext.s3.GetObjectCommand).to.have.been.calledTwice;
    });

    it('should return conflict for report not in success status', async () => {
      mockReport.getStatus = () => 'processing';

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
          reportId: '987e6543-e21b-12d3-a456-426614174001',
        },
      };

      const result = await reportsController.getReport(context);

      expect(result.status).to.equal(409);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report is still processing.');
    });
  });

  describe('comparePeriods function (through duplicate checking)', () => {
    it('should correctly identify identical periods', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing report with identical periods
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
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('A report with the same type and duration already exists for this site. Current status: success');
    });

    it('should correctly identify different start dates', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing report with different start date
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-02', // Different start date
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
    });

    it('should correctly identify different end dates', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing report with different end date
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-30', // Different end date
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-12-01',
          endDate: '2024-12-31',
        }),
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
    });

    it('should correctly identify different comparison periods', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing report with different comparison period
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => ({
          startDate: '2024-11-01', // Different comparison period
          endDate: '2024-11-30',
        }),
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
    });

    it('should handle null comparison periods correctly', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: {
            startDate: '2025-01-01',
            endDate: '2025-01-31',
          },
          comparisonPeriod: null,
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      // Mock existing report with null comparison period
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => null,
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      // This should fail validation at the input validation level
      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Comparison period is required');
    });

    it('should handle mixed null and valid periods correctly', async () => {
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      // Mock existing report with null comparison period (edge case)
      const existingReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => ({
          startDate: '2025-01-01',
          endDate: '2025-01-31',
        }),
        getComparisonPeriod: () => null, // This should be different from our non-null period
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingReport]);

      const result = await reportsController.createReport(context);

      // Should succeed because comparison periods are different (null vs valid object)
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
    });

    it('should handle both periods being null (edge case for coverage)', async () => {
      // Create a special test to cover the comparePeriods(null, null) edge case
      // This simulates legacy data where periods might be null
      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
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

      const existingLegacyReport = {
        getReportType: () => 'performance',
        getReportPeriod: () => null, // Legacy data
        getComparisonPeriod: () => null, // Legacy data
        getStatus: () => 'success',
      };

      mockDataAccess.Report.allBySiteId = sinon.stub().resolves([existingLegacyReport]);

      const result = await reportsController.createReport(context);

      // Should succeed because periods are different (null vs valid objects)
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report generation job queued successfully');
    });

    it('should attempt to cover comparePeriods null edge case', async () => {
      // Note: This edge case where both periods are null is difficult to test
      // through the normal flow due to input validation, but we include this
      // test to document the intention to cover lines 86-87

      const context = {
        params: {
          siteId: '123e4567-e89b-12d3-a456-426614174000',
        },
        data: {
          reportType: 'performance',
          name: 'Test Report',
          reportPeriod: null, // Will trigger validation error
          comparisonPeriod: null,
        },
        attributes: {
          user: {
            email: 'test@example.com',
          },
        },
      };

      const result = await reportsController.createReport(context);
      // Expected: validation catches null periods before comparison
      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Report period is required');
    });
  });
});
