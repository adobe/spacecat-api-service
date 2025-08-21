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
import chaiAsPromised from 'chai-as-promised';

import { ReportDto } from '../../src/dto/report.js';

use(chaiAsPromised);

describe('Report DTO', () => {
  let mockReport;

  beforeEach(() => {
    mockReport = {
      getId: () => 'test-report-id',
      getSiteId: () => 'test-site-id',
      getReportType: () => 'performance',
      getStatus: () => 'success',
      getReportPeriod: () => ({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      }),
      getComparisonPeriod: () => ({
        startDate: '2023-12-01',
        endDate: '2023-12-31',
      }),
      getStoragePath: () => 'reports/test-site-id/performance/test-report-id/',
      getCreatedAt: () => '2024-01-15T10:30:00Z',
      getUpdatedAt: () => '2024-01-15T11:45:00Z',
      getUpdatedBy: () => 'test@example.com',
    };
  });

  describe('toJSON', () => {
    it('returns report JSON without data field when no presignedUrlObject provided', () => {
      const result = ReportDto.toJSON(mockReport);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
      });
    });

    it('returns report JSON with data field when both presigned URLs provided', () => {
      const presignedUrlObject = {
        rawPresignedUrl: 'https://s3.amazonaws.com/bucket/raw/report.json?signature=abc',
        mystiquePresignedUrl: 'https://s3.amazonaws.com/bucket/mystique/report.json?signature=def',
      };

      const result = ReportDto.toJSON(mockReport, presignedUrlObject);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
        data: {
          rawPresignedUrl: 'https://s3.amazonaws.com/bucket/raw/report.json?signature=abc',
          mystiquePresignedUrl: 'https://s3.amazonaws.com/bucket/mystique/report.json?signature=def',
        },
      });
    });

    it('returns report JSON with data field when only rawPresignedUrl provided', () => {
      const presignedUrlObject = {
        rawPresignedUrl: 'https://s3.amazonaws.com/bucket/raw/report.json?signature=abc',
      };

      const result = ReportDto.toJSON(mockReport, presignedUrlObject);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
        data: {
          rawPresignedUrl: 'https://s3.amazonaws.com/bucket/raw/report.json?signature=abc',
        },
      });
    });

    it('returns report JSON with data field when only mystiquePresignedUrl provided', () => {
      const presignedUrlObject = {
        mystiquePresignedUrl: 'https://s3.amazonaws.com/bucket/mystique/report.json?signature=def',
      };

      const result = ReportDto.toJSON(mockReport, presignedUrlObject);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
        data: {
          mystiquePresignedUrl: 'https://s3.amazonaws.com/bucket/mystique/report.json?signature=def',
        },
      });
    });

    it('returns report JSON without data field when presignedUrlObject has no URLs', () => {
      const presignedUrlObject = {};

      const result = ReportDto.toJSON(mockReport, presignedUrlObject);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
      });
    });

    it('returns report JSON without data field when presignedUrlObject has null URLs', () => {
      const presignedUrlObject = {
        rawPresignedUrl: null,
        mystiquePresignedUrl: null,
      };

      const result = ReportDto.toJSON(mockReport, presignedUrlObject);

      expect(result).to.deep.equal({
        id: 'test-report-id',
        siteId: 'test-site-id',
        reportType: 'performance',
        status: 'success',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        storagePath: 'reports/test-site-id/performance/test-report-id/',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T11:45:00Z',
        updatedBy: 'test@example.com',
      });
    });
  });

  describe('toQueueMessage', () => {
    it('returns queue message JSON with correct structure', () => {
      const jobId = 'test-job-id';
      const name = 'Test Report';
      const initiatedBy = 'test-user@example.com';

      const result = ReportDto.toQueueMessage(mockReport, jobId, name, initiatedBy);

      expect(result).to.deep.include({
        reportId: 'test-job-id',
        siteId: 'test-site-id',
        name: 'Test Report',
        reportType: 'performance',
        reportPeriod: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        },
        comparisonPeriod: {
          startDate: '2023-12-01',
          endDate: '2023-12-31',
        },
        initiatedBy: 'test-user@example.com',
      });

      // Check that timestamp is a valid ISO string
      expect(result.timestamp).to.be.a('string');
      expect(() => new Date(result.timestamp)).to.not.throw();
    });
  });
});
