/*
 * Copyright 2023 Adobe. All rights reserved.
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

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import AuditsController from '../../src/controllers/audits.js';
import { AuditDto } from '../../src/dto/audit.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('Audits Controller', () => {
  const sandbox = sinon.createSandbox();

  const auditFunctions = [
    'getAllForSite',
    'getAllLatest',
    'getAllLatestForSite',
    'getLatestForSite',
  ];

  const mockAudits = [
    {
      siteId: 'site1',
      auditType: 'lhs-mobile',
      auditedAt: '2022-04-10T00:00:00.000Z',
      isLive: true,
      fullAuditRef: 'https://lh-metrics.com/audit/123',
      auditResult: {
        scores: {
          performance: 0.5,
          accessibility: 0.5,
          'best-practices': 0.5,
          seo: 0.5,
        },
      },
    },
    {
      siteId: 'site1',
      auditType: 'lhs-mobile',
      auditedAt: '2021-01-01T00:00:00.000Z',
      isLive: true,
      fullAuditRef: 'https://lh-metrics.com/audit/234',
      auditResult: {
        scores: {
          performance: 0.5,
          accessibility: 0.5,
          'best-practices': 0.5,
          seo: 0.5,
        },
      },
    },
    {
      siteId: 'site1',
      auditType: 'cwv',
      auditedAt: '2021-03-12T01:00:00.000Z',
      isLive: true,
      fullAuditRef: 'https://lh-metrics.com/audit/345',
      auditResult: {
        scores: {
          'first-contentful-paint': 0.5,
          'largest-contentful-paint': 0.5,
          'cumulative-layout-shift': 0.5,
          'total-blocking-time': 0.5,
        },
      },
    },
  ].map((audit) => AuditDto.fromJson(audit));

  const mockDataAccess = {
    getAuditsForSite: sandbox.stub(),
    getLatestAudits: sandbox.stub(),
    getLatestAuditsForSite: sandbox.stub(),
    getLatestAuditForSite: sandbox.stub(),
  };

  let auditsController;

  beforeEach(() => {
    auditsController = AuditsController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    auditFunctions.forEach((funcName) => {
      expect(auditsController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(auditsController).forEach((funcName) => {
      expect(auditFunctions).to.include(funcName);
    });
  });

  it('throws an error if data access is not an object', () => {
    expect(() => AuditsController()).to.throw('Data access required');
  });

  describe('getAllForSite', () => {
    it('retrieves all audits for a site', async () => {
      const siteId = 'site1';
      const expectedAudits = mockAudits.map(AuditDto.toJSON);

      mockDataAccess.getAuditsForSite.resolves(mockAudits);

      const result = await auditsController.getAllForSite({ params: { siteId } });
      const audits = await result.json();

      expect(mockDataAccess.getAuditsForSite.calledWith(siteId, undefined, false)).to.be.true;
      expect(audits).to.deep.equal(expectedAudits);
    });

    it('retrieves all audits descending for a site', async () => {
      const siteId = 'site1';
      const expectedAudits = mockAudits.map(AuditDto.toJSON);

      mockDataAccess.getAuditsForSite.resolves(mockAudits);

      const result = await auditsController.getAllForSite(
        { params: { siteId }, data: { ascending: 'true' } },
      );
      const audits = await result.json();

      expect(mockDataAccess.getAuditsForSite.calledWith(siteId, undefined, true)).to.be.true;
      expect(audits).to.deep.equal(expectedAudits);
    });

    it('handles missing site ID', async () => {
      const result = await auditsController.getAllForSite({ params: {} });

      expect(result.status).to.equal(400);
    });
  });

  describe('getAllLatest', () => {
    it('retrieves all latest audits', async () => {
      const auditType = 'security';
      const expectedAudits = mockAudits.map(AuditDto.toJSON);

      mockDataAccess.getLatestAudits.resolves(mockAudits);

      const result = await auditsController.getAllLatest({ params: { auditType } });
      const audits = await result.json();

      expect(mockDataAccess.getLatestAudits.calledWith(auditType, false)).to.be.true;
      expect(audits).to.deep.equal(expectedAudits);
    });

    it('retrieves all latest audits with sorting', async () => {
      const auditType = 'security';
      const expectedAudits = mockAudits.map(AuditDto.toJSON);

      mockDataAccess.getLatestAudits.resolves(mockAudits);

      const result = await auditsController.getAllLatest(
        { params: { auditType }, data: { ascending: 'true' } },
      );
      const audits = await result.json();

      expect(mockDataAccess.getLatestAudits.calledWith(auditType, true)).to.be.true;
      expect(audits).to.deep.equal(expectedAudits);
    });

    it('handles missing audit type', async () => {
      const result = await auditsController.getAllLatest({ params: {} });

      expect(result.status).to.equal(400);
    });
  });

  describe('getAllLatestForSite', () => {
    it('retrieves all latest audits for a site', async () => {
      const siteId = 'site1';
      const expectedAudits = mockAudits.map(AuditDto.toJSON);

      mockDataAccess.getLatestAuditsForSite.resolves(mockAudits);

      const result = await auditsController.getAllLatestForSite({ params: { siteId } });
      const audits = await result.json();

      expect(mockDataAccess.getLatestAuditsForSite.calledWith(siteId)).to.be.true;
      expect(audits).to.deep.equal(expectedAudits);
    });

    it('handles missing site ID', async () => {
      const result = await auditsController.getAllLatestForSite({ params: {} });

      expect(result.status).to.equal(400);
    });
  });

  describe('getLatestForSite', () => {
    it('retrieves the latest audit for a site', async () => {
      const siteId = 'site1';
      const auditType = 'security';
      const expectedAudit = AuditDto.toJSON(mockAudits[0]);

      mockDataAccess.getLatestAuditForSite.resolves(mockAudits[0]);

      const result = await auditsController.getLatestForSite({ params: { siteId, auditType } });
      const audit = await result.json();

      expect(mockDataAccess.getLatestAuditForSite.calledWith(siteId, auditType)).to.be.true;
      expect(audit).to.deep.equal(expectedAudit);
    });

    it('handles missing site ID', async () => {
      const result = await auditsController.getLatestForSite({ params: { auditType: 'lhs-mobile' } });

      expect(result.status).to.equal(400);
    });

    it('handles missing audit type', async () => {
      const result = await auditsController.getLatestForSite({ params: { siteId: 'site1' } });

      expect(result.status).to.equal(400);
    });

    it('handles audit not found', async () => {
      mockDataAccess.getLatestAuditForSite.resolves(null);

      const result = await auditsController.getLatestForSite({ params: { siteId: 'site1', auditType: 'lhs-mobile' } });

      expect(result.status).to.equal(404);
    });
  });
});
