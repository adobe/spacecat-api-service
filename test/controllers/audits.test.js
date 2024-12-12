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

import { createAudit } from '@adobe/spacecat-shared-data-access/src/models/audit.js';
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import AuditsController from '../../src/controllers/audits.js';
import { AuditDto } from '../../src/dto/audit.js';

use(chaiAsPromised);

describe('Audits Controller', () => {
  const sandbox = sinon.createSandbox();

  const auditFunctions = [
    'getAllForSite',
    'getAllLatest',
    'getAllLatestForSite',
    'getLatestForSite',
    'patchAuditForSite',
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
      previousAuditResult: {
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
      previousAuditResult: {
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
      previousAuditResult: { scores: {} },
    },
  ].map((audit) => createAudit(audit));

  const handlers = { some_audit: {}, 'broken-backlinks': {} };

  const mockConfiguration = {
    getHandlers: sandbox.stub().returns(handlers),
  };

  const mockDataAccess = {
    getAuditsForSite: sandbox.stub(),
    getConfiguration: sandbox.stub().resolves(mockConfiguration),
    getLatestAudits: sandbox.stub(),
    getLatestAuditsForSite: sandbox.stub(),
    getLatestAuditForSite: sandbox.stub(),
    patchAuditForSite: sandbox.stub(),
    getSiteByID: sandbox.stub(),
    updateSite: sandbox.stub(),
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

  describe('patchAuditForSite', () => {
    it('returns bad request if site ID is missing', async () => {
      const result = await auditsController.patchAuditForSite({ params: { auditType: 'broken-backlinks' } });
      expect(result.status).to.equal(400);
    });

    it('returns bad request if audit type is missing', async () => {
      const result = await auditsController.patchAuditForSite({ params: { siteId: 'site1' } });
      expect(result.status).to.equal(400);
    });

    it('returns bad request if no updates are provided', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';

      const context = {
        params: { siteId, auditType },
        data: {},
      };

      const site = {
        getConfig: () => ({
          getHandlerConfig: () => ({}),
          updateAuditTypeConfig: sinon.stub(),
        }),
        updateAuditTypeConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'No updates provided');
    });

    it('returns bad request if excludedURLs is not an array', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = 'http://valid-url.com';

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'No updates provided');
    });

    it('returns bad request if excludedURLs contains invalid URLs', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = ['invalid-url', 'http://valid-url.com'];

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };

      const site = {
        getConfig: () => ({
          getHandlerConfig: () => ({}),
        }),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'Invalid URL format');
    });

    it('updates excluded URLs when excludedURLs is empty', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = [];

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };
      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([]),
        updateExcludedURLs: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: {} }),
          getSlackConfig: () => {},
          getImports: () => [],
          getHandlers: () => (({ [auditType]: {} })),
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateExcludedURLs.calledWith(auditType, [])).to.be.true;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('updates excluded URLs when excludedURLs is undefined', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = ['https://foo.com', 'https://bar.com'];

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns(undefined),
        getFixedURLs: sinon.stub().returns(undefined),
        getManualOverwrites: sinon.stub().returns(undefined),
        updateExcludedURLs: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateExcludedURLs.calledWith(auditType, ['https://foo.com', 'https://bar.com'])).to.be.true;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('updates excluded URLs when excludedURLs has items', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = ['https://example.com/page1', 'https://example.com/page2'];

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns(['https://example.com/page3']),
        getManualOverwrites: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        updateExcludedURLs: sinon.stub(),
        disabled: sinon.stub().returns(false),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateExcludedURLs.calledWith(auditType, [
        'https://example.com/page3',
        'https://example.com/page1',
        'https://example.com/page2',
      ])).to.be.true;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('handles duplicates in excludedURLs', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const excludedURLs = ['https://example.com/page1', 'https://example.com/page1'];

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns(['https://example.com/page2']),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([]),
        updateExcludedURLs: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateExcludedURLs.calledWith(auditType, [
        'https://example.com/page2',
        'https://example.com/page1',
      ])).to.be.true;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('returns not found if site is not found', async () => {
      const siteId = 'nonexistent-site';
      const auditType = 'broken-backlinks';

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs: [] },
      };

      mockDataAccess.getSiteByID.resolves(null);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(404);
      const error = await result.json();
      expect(error).to.have.property('message', 'Site not found');
    });

    it('returns not found if audit type is not found', async () => {
      const siteId = 'site1';
      const auditType = 'nonexistent-audit-type';

      const context = {
        params: { siteId, auditType },
        data: { excludedURLs: [] },
      };

      mockDataAccess.getSiteByID.resolves({ siteId });

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(404);
      const error = await result.json();
      expect(error).to.have.property(
        'message',
        `The "${auditType}" is not present in the configuration. List of allowed audits:`
        + ` ${Object.keys(handlers).join(', ')}.`,
      );
    });

    it('merges manual overwrites correctly', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
      ];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateManualOverwrites.calledWith(auditType, [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
        { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
      ])).to.be.false;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('does not merge manual overwrites if manualOverwrites is empty', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(200);
      expect(site.getConfig().updateManualOverwrites.calledWith(auditType, [])).to.be.true;
      expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
      expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
    });

    it('validates URLs in manual overwrites', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
        { brokenTargetURL: 'invalid-url', targetURL: 'https://example.com/page2-new' }, // Invalid URL
      ];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };
      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'Invalid URL format');
    });

    it('validates manual overwrites as objects', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
        'not-an-object',
      ];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
          getImports: () => [],
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'Manual overwrite must be an object');
    });

    it('returns badRequest when manualOverwrites contains an empty object', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
        {}, // Empty object
      ];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'Manual overwrite object cannot be empty');
    });

    it('returns badRequest when manualOverwrites contains an object with missing brokenTargetURL or targetURL', async () => {
      const siteId = 'site1';
      const auditType = 'broken-backlinks';
      const manualOverwrites = [
        { brokenTargetURL: 'https://example.com/page1', targetURL: 'https://example.com/page1-new' },
        { brokenTargetURL: 'https://example.com/page2' }, // Missing targetURL
      ];

      const context = {
        params: { siteId, auditType },
        data: { manualOverwrites },
      };

      const handlerTypeConfig = {
        getExcludedURLs: sinon.stub().returns([]),
        getFixedURLs: sinon.stub().returns([]),
        getManualOverwrites: sinon.stub().returns([
          { brokenTargetURL: 'https://example.com/page2', targetURL: 'https://example.com/page2-new' },
        ]),
        updateManualOverwrites: sinon.stub(),
        disabled: sinon.stub().returns(false),
      };

      const site = {
        getConfig: () => ({
          ...handlerTypeConfig,
          getHandlerConfig: (type) => ({ [type]: handlerTypeConfig }),
          getSlackConfig: () => {},
          getHandlers: () => (({ [auditType]: {} })),
        }),
        updateConfig: sinon.stub(),
      };

      mockDataAccess.getSiteByID.resolves(site);

      const result = await auditsController.patchAuditForSite(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error).to.have.property('message', 'Manual overwrite must have both brokenTargetURL and targetURL');
    });

    describe('process groupedURLs parameter', () => {
      const siteId = 'site0';
      const auditType = 'broken-backlinks';

      let siteConfig;
      let site;

      beforeEach(() => {
        siteConfig = {
          getHandlerConfig: sandbox.stub(),
          getGroupedURLs: sandbox.stub(),
          updateGroupedURLs: sandbox.stub(),
          getSlackConfig: () => {},
          getHandlers: () => {},
          getImports: () => {},
        };
        site = {
          getConfig: () => siteConfig,
          updateConfig: sinon.stub(),
        };

        mockDataAccess.getSiteByID.withArgs(siteId).resolves(site);
      });

      it('returns a bad request if the groupedURLs parameter is not an array', async () => {
        const context = {
          params: { siteId, auditType },
          data: { groupedURLs: 'invalid_type' },
        };
        const result = await auditsController.patchAuditForSite(context);
        const error = await result.json();

        expect(siteConfig.updateGroupedURLs.called).to.be.false;
        expect(site.updateConfig.called).to.be.false;
        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'No updates provided');
      });

      it('returns a bad request if the groupedURLs pattern is not a valid regular expression', async () => {
        const context = {
          params: { siteId, auditType },
          data: {
            groupedURLs: [
              { name: 'catalog', pattern: '[a-z-invalid_regexp' },
              { name: 'blog', pattern: '/posts/' },
            ],
          },
        };

        const result = await auditsController.patchAuditForSite(context);
        const error = await result.json();

        expect(siteConfig.updateGroupedURLs.called).to.be.false;
        expect(site.updateConfig.called).to.be.false;
        expect(result.status).to.equal(400);
        expect(error).to.have.property('message', 'Invalid regular expression in pattern for "catalog": "[a-z-invalid_regexp".');
      });

      it('successful patch update', async () => {
        const currentGroupedURLs = [
          { name: 'news', pattern: '/news/' },
        ];
        const requestGroupedURLs = [
          { name: 'catalog', pattern: '/products/' },
          { name: 'blog', pattern: '/posts/' },
        ];
        const expectedGroupedURLs = [...currentGroupedURLs, ...requestGroupedURLs];

        const context = {
          params: { siteId, auditType },
          data: { groupedURLs: requestGroupedURLs },
        };

        siteConfig.getHandlerConfig.withArgs(auditType);
        siteConfig.getGroupedURLs.withArgs(auditType).returns(currentGroupedURLs);

        const result = await auditsController.patchAuditForSite(context);

        expect(siteConfig.updateGroupedURLs.getCall(0).args[0]).to.be.equal(auditType);
        expect(siteConfig.updateGroupedURLs.getCall(0).args[1]).to.deep.equal(expectedGroupedURLs);
        expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
        expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
        expect(result.status).to.equal(200);
      });

      it('successful update when groupedURLs is empty, delete all existing groups', async () => {
        const currentGroupedURLs = [
          { name: 'news', pattern: '/news/' },
        ];
        const requestGroupedURLs = [];

        const context = {
          params: { siteId, auditType },
          data: { groupedURLs: requestGroupedURLs },
        };

        siteConfig.getHandlerConfig.withArgs(auditType);
        siteConfig.getGroupedURLs.withArgs(auditType).returns(currentGroupedURLs);

        const result = await auditsController.patchAuditForSite(context);

        expect(siteConfig.updateGroupedURLs.calledWith(auditType, [])).to.be.true;
        expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
        expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
        expect(result.status).to.equal(200);
      });

      it('successful update if groupedURLs is undefined in the site config', async () => {
        const currentGroupedURLs = undefined;
        const requestGroupedURLs = [
          { name: 'catalog', pattern: '/products/' },
          { name: 'blog', pattern: '/posts/' },
        ];

        const context = {
          params: { siteId, auditType },
          data: { groupedURLs: requestGroupedURLs },
        };

        siteConfig.getHandlerConfig.withArgs(auditType);
        siteConfig.getGroupedURLs.withArgs(auditType).returns(currentGroupedURLs);

        const result = await auditsController.patchAuditForSite(context);

        expect(siteConfig.updateGroupedURLs.getCall(0).args[0]).to.be.equal(auditType);
        expect(siteConfig.updateGroupedURLs.getCall(0).args[1]).to.deep.equal(requestGroupedURLs);
        expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
        expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
        expect(result.status).to.equal(200);
      });

      it(
        'updates existing group instead of creating a new one for duplicate pattern',
        async () => {
          const currentGroupedURLs = [
            { name: 'page', pattern: '/page/*' },
            { name: 'existed_group', pattern: '/pattern/*' },
          ];
          const requestGroupedURLs = [
            { name: 'group_with_the_same_pattern', pattern: '/pattern/*' },
          ];
          const expectedGroupedURLs = [
            { name: 'page', pattern: '/page/*' },
            { name: 'group_with_the_same_pattern', pattern: '/pattern/*' },
          ];

          const context = {
            params: { siteId, auditType },
            data: { groupedURLs: requestGroupedURLs },
          };

          siteConfig.getHandlerConfig.withArgs(auditType);
          siteConfig.getGroupedURLs.withArgs(auditType).returns(currentGroupedURLs);

          const result = await auditsController.patchAuditForSite(context);

          expect(siteConfig.updateGroupedURLs.getCall(0).args[0]).to.be.equal(auditType);
          expect(
            siteConfig.updateGroupedURLs.getCall(0).args[1],
          ).to.deep.equal(expectedGroupedURLs);
          expect(site.updateConfig.calledWith(sinon.match.any)).to.be.true;
          expect(mockDataAccess.updateSite.calledWith(site)).to.be.true;
          expect(result.status).to.equal(200);
        },
      );
    });
  });
});
