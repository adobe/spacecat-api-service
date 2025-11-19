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
import esmock from 'esmock';

describe('Site Metrics Controller', () => {
  let SiteMetricsController;
  let contextMock;
  let dataAccessMock;
  let logMock;
  let getSiteMetricsStub;
  let validateAndNormalizeDatesStub;
  let AccessControlUtilStub;

  const mockSite = {
    getId: sinon.stub().returns('a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
    getBaseURL: sinon.stub().returns('https://example.com'),
  };

  const mockMetrics = {
    siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    startDate: '2025-01-01',
    endDate: '2025-01-31',
    audits: {
      total: 10,
      successful: 8,
      failed: 2,
      successRate: 80.0,
      byType: {
        cwv: { total: 5, successful: 4, failed: 1 },
        seo: { total: 5, successful: 4, failed: 1 },
      },
    },
    opportunities: {
      total: 5,
      byType: {
        'seo-backlinks': 3,
        'cwv-lcp': 2,
      },
    },
    suggestions: {
      total: 8,
      byStatus: {
        NEW: 5,
        APPROVED: 3,
      },
    },
  };

  beforeEach(async () => {
    logMock = {
      error: sinon.stub(),
      info: sinon.stub(),
    };

    dataAccessMock = {
      Site: {
        findById: sinon.stub().resolves(mockSite),
      },
    };

    contextMock = {
      dataAccess: dataAccessMock,
      log: logMock,
    };

    getSiteMetricsStub = sinon.stub().resolves(mockMetrics);
    validateAndNormalizeDatesStub = sinon.stub().returns({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      error: null,
    });

    AccessControlUtilStub = sinon.stub().returns({
      hasAccess: sinon.stub().resolves(true),
    });

    SiteMetricsController = await esmock(
      '../../src/controllers/site-metrics.js',
      {
        '../../src/support/site-metrics-service.js': {
          getSiteMetrics: getSiteMetricsStub,
          validateAndNormalizeDates: validateAndNormalizeDatesStub,
        },
        '../../src/support/access-control-util.js': {
          default: AccessControlUtilStub,
        },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Constructor', () => {
    it('should throw error when context is not provided', async () => {
      const RealController = (await import('../../src/controllers/site-metrics.js')).default;
      expect(() => RealController()).to.throw('Context required');
    });

    it('should throw error when context is empty', async () => {
      const RealController = (await import('../../src/controllers/site-metrics.js')).default;
      expect(() => RealController(null)).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', async () => {
      const RealController = (await import('../../src/controllers/site-metrics.js')).default;
      expect(() => RealController({ log: logMock })).to.throw('Data access required');
    });
  });

  describe('getMetricsForSite', () => {
    it('should return metrics for a valid site', async () => {
      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: { startDate: '2025-01-01', endDate: '2025-01-31' },
        authInfo: { userId: 'user-1' },
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.siteId).to.equal('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(body.baseURL).to.equal('https://example.com');
      expect(body.audits.total).to.equal(10);
    });

    it('should return bad request for invalid site ID', async () => {
      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'invalid-id' },
        query: {},
        authInfo: {},
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(400);
      const body = await response.text();
      expect(body).to.include('Invalid site ID format');
    });

    it('should return bad request for invalid date format', async () => {
      validateAndNormalizeDatesStub.returns({
        error: 'Invalid start date format. Use YYYY-MM-DD format.',
      });

      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: { startDate: 'invalid-date' },
        authInfo: {},
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(400);
      const body = await response.text();
      expect(body).to.include('Invalid start date format');
    });

    it('should return not found when site does not exist', async () => {
      dataAccessMock.Site.findById.resolves(null);

      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: {},
        authInfo: {},
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(404);
      const body = await response.text();
      expect(body).to.include('Site not found');
    });

    it('should return forbidden when user does not have access', async () => {
      AccessControlUtilStub.returns({
        hasAccess: sinon.stub().resolves(false),
      });

      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: {},
        authInfo: { userId: 'user-1' },
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(403);
      const body = await response.text();
      expect(body).to.include('Only users belonging to the organization can view its metrics');
    });

    it('should work with no query parameters', async () => {
      validateAndNormalizeDatesStub.returns({
        startDate: '2000-01-01',
        endDate: '2025-11-19',
        error: null,
      });

      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: {},
        authInfo: { userId: 'user-1' },
      };

      const response = await controller.getMetricsForSite(req);

      expect(response.status).to.equal(200);
      expect(validateAndNormalizeDatesStub.calledWith(undefined, undefined)).to.be.true;
    });

    it('should call getSiteMetrics with correct parameters', async () => {
      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: { startDate: '2025-01-01', endDate: '2025-01-31' },
        authInfo: { userId: 'user-1' },
      };

      await controller.getMetricsForSite(req);

      expect(getSiteMetricsStub.calledOnce).to.be.true;
      expect(getSiteMetricsStub.firstCall.args[0]).to.equal(contextMock);
      expect(getSiteMetricsStub.firstCall.args[1]).to.equal('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(getSiteMetricsStub.firstCall.args[2]).to.equal('2025-01-01');
      expect(getSiteMetricsStub.firstCall.args[3]).to.equal('2025-01-31');
    });

    it('should throw error when getSiteMetrics fails', async () => {
      const metricsError = new Error('Database connection failed');
      getSiteMetricsStub.rejects(metricsError);

      const controller = SiteMetricsController(contextMock);
      const req = {
        params: { siteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        query: {},
        authInfo: { userId: 'user-1' },
      };

      try {
        await controller.getMetricsForSite(req);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Database connection failed');
        expect(logMock.error.calledOnce).to.be.true;
        expect(logMock.error.firstCall.args[0]).to.include('Error fetching metrics');
      }
    });
  });
});
