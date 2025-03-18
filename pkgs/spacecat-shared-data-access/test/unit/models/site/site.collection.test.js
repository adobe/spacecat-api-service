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

import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { stub } from 'sinon';
import sinonChai from 'sinon-chai';

import Site from '../../../../src/models/site/site.model.js';
import SiteCollection from '../../../../src/models/site/site.collection.js';
import schema from '../../../../src/models/site/site.schema.js';

import { createElectroMocks } from '../../util.js';
import EntityRegistry from '../../../../src/models/base/entity.registry.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('SiteCollection', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockLogger;
  let model;
  let mockSchema;

  const mockRecord = { siteId: 's12345' };

  beforeEach(() => {
    ({
      mockElectroService,
      mockEntityRegistry,
      mockLogger,
      collection: instance,
      model,
      schema: mockSchema,
    } = createElectroMocks(Site, mockRecord));
  });

  describe('constructor', () => {
    it('initializes the SiteCollection instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.electroService).to.equal(mockElectroService);
      expect(instance.entityRegistry).to.equal(mockEntityRegistry);
      expect(instance.schema).to.equal(mockSchema);
      expect(instance.log).to.equal(mockLogger);

      expect(model).to.be.an('object');
    });
  });

  describe('allSitesToAudit', () => {
    it('returns all sites to audit', async () => {
      instance.all = stub().resolves([{ getId: () => 's12345' }]);

      const result = await instance.allSitesToAudit();

      expect(result).to.deep.equal(['s12345']);
      expect(instance.all).to.have.been.calledOnceWithExactly({}, { attributes: ['siteId'] });
    });
  });

  describe('allWithLatestAudit', () => {
    const mockAudit = {
      getId: () => 's12345',
      getSiteId: () => 's12345',
    };

    const mockSite = {
      getId: () => 's12345',
      _accessorCache: { getLatestAuditByAuditType: null },
    };

    const mockSiteNoAudit = {
      getId: () => 'x12345',
      _accessorCache: { getLatestAuditByAuditType: null },
    };

    beforeEach(() => {
      mockEntityRegistry.getCollection = stub().returns({
        all: stub().resolves([mockAudit]),
      });
    });

    it('throws error if audit type is not provided', async () => {
      await expect(instance.allWithLatestAudit()).to.be.rejectedWith('auditType is required');
    });

    it('returns all sites with latest audit', async () => {
      instance.all = stub().resolves([mockSite]);

      const result = await instance.allWithLatestAudit('cwv');

      expect(result).to.deep.equal([mockSite]);
      expect(instance.all).to.have.been.calledOnce;
    });

    it('returns all sites with latest audit by delivery type', async () => {
      instance.allByDeliveryType = stub().resolves([mockSite, mockSiteNoAudit]);

      const result = await instance.allWithLatestAudit('cwv', 'asc', 'aem_cs');

      expect(result).to.deep.equal([mockSite, mockSiteNoAudit]);
      expect(instance.allByDeliveryType).to.have.been.calledOnce;
    });
  });
});

describe('SiteCollection permissions', () => {
  it('checks permissions on create site', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/o123/site/', actions: ['C'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const called = [];
    const entity = {
      create: (el) => ({
        go: () => {
          called.push(`create:${JSON.stringify(el)}`);
          return { data: el };
        },
      }),
    };

    const ml = { debug: () => { }, info: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);

    const siteData = { organizationId: 'o123', siteId: 's12345' };

    const site = await sc.create(siteData);
    expect(site.getId()).to.equal('s12345');
    expect(called).to.deep.equal(['create:{"organizationId":"o123","siteId":"s12345"}']);
    expect(() => site.getOrganizationId()).to.throw('Permission denied');
  });

  it('cannot create site due to lack of permission', async () => {
    // No permissions at all
    function getAclCtx() {
      return {
        acls: [],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const called = [];
    const entity = {
      create: (el) => ({
        go: () => {
          called.push(`create:${JSON.stringify(el)}`);
          return { data: el };
        },
      }),
    };

    const ml = { debug: () => { }, info: () => { }, error: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);

    const siteData = { organizationId: 'o123', siteId: 's12345' };

    await expect(sc.create(siteData)).to.be.rejected;
    expect(called).to.be.empty;
  });

  it('test create batch permission', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/o123/site/s67890', actions: ['C', 'R'] },
            { path: '/organization/*/site/**', actions: ['C'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const called = [];
    const entity = {
      put: (el) => ({
        params: () => ({
          Item: el,
        }),
        go: () => {
          called.push(`put:${JSON.stringify(el)}`);
          return { data: el };
        },
      }),
    };

    const ml = { debug: () => { }, info: () => { }, error: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);

    const siteData1 = { organizationId: 'o123', siteId: 's12345' };
    const siteData2 = { organizationId: 'o123', siteId: 's67890' };
    const items = [siteData1, siteData2];
    const { createdItems } = await sc.createMany(items);
    expect(createdItems).to.have.length(2);
    expect(called).to.have.length(1);
    expect(called[0]).to.equal('put:[{"organizationId":"o123","siteId":"s12345"},{"organizationId":"o123","siteId":"s67890"}]');

    const idx1 = createdItems.findIndex((i) => i.getId() === 's12345');
    expect(createdItems[idx1].getId()).to.equal('s12345');
    expect(() => createdItems[idx1].getOrganizationId()).to.throw('Permission denied');
    expect(createdItems[1 - idx1].getId()).to.equal('s67890');
    expect(createdItems[1 - idx1].getOrganizationId()).to.equal('o123');
  });

  it('test create batch no permission', async () => {
    // no create permissions
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/o123/site/s67890', actions: ['R'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const called = [];
    const entity = {
      put: (el) => ({
        params: () => ({
          Item: el,
        }),
        go: () => {
          called.push(`put:${JSON.stringify(el)}`);
          return { data: el };
        },
      }),
    };

    const ml = { debug: () => { }, info: () => { }, error: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);

    const siteData1 = { organizationId: 'o123', siteId: 's12345' };
    const siteData2 = { organizationId: 'o123', siteId: 's67890' };
    const items = [siteData1, siteData2];

    await expect(sc.createMany(items)).to.be.rejected;
    expect(called).to.be.empty;
  });

  it('can find by it with permission', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/11111111-bbbb-1ccc-8ddd-111111111111/site/aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee', actions: ['R'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const entity = {
      get: (id) => ({
        go: () => ({ data: { organizationId: '11111111-bbbb-1ccc-8ddd-111111111111', ...id } }),
      }),
    };

    const ml = { debug: () => { }, info: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);
    const site = await sc.findById('aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee');
    expect(site.getId()).to.equal('aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee');
    expect(site.getOrganizationId()).to.equal('11111111-bbbb-1ccc-8ddd-111111111111');
  });

  it('can find by it with no permission', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const entity = {
      get: (id) => ({
        go: () => ({ data: { organizationId: '11111111-bbbb-1ccc-8ddd-111111111111', ...id } }),
      }),
    };

    const ml = { debug: () => { }, info: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);
    const site = await sc.findById('aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee');
    expect(site.getId()).to.equal('aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee');
    expect(() => site.getOrganizationId()).to.throw('Permission denied');
  });

  it('remove by ids with permission', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/11111111-bbbb-1ccc-8ddd-111111111111/site/aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee', actions: ['D'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const deleted = [];
    const entity = {
      delete: (id) => ({
        go: () => {
          deleted.push(id);
        },
      }),
      get: (id) => ({
        go: () => ({ data: { organizationId: '11111111-bbbb-1ccc-8ddd-111111111111', ...id } }),
      }),
    };

    const ml = { debug: () => { }, info: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);
    await sc.removeByIds(['aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee']);
    expect(deleted).to.deep.equal([[{ siteId: 'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee' }]]);
  });

  it('remove by ids with no permission', async () => {
    function getAclCtx() {
      return {
        acls: [{
          acl: [
            { path: '/organization/11111111-bbbb-1ccc-8ddd-111111111111/site/aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee', actions: ['D'] },
          ],
        }],
        aclEntities: { model: ['site', 'organization'] },
      };
    }

    const deleted = [];
    const entity = {
      delete: (id) => ({
        go: () => {
          deleted.push(id);
        },
      }),
      get: (id) => ({
        go: () => ({ data: { organizationId: '11111111-bbbb-1ccc-8ddd-111111111111', ...id } }),
      }),
    };

    const ml = { debug: () => { }, info: () => { } };
    const es = { entities: { site: entity } };
    const er = new EntityRegistry(es, { aclCtx: getAclCtx() }, ml);
    const sc = new SiteCollection(es, er, schema, ml);

    // Only 1 of these has permission, reject the whole request
    await expect(sc.removeByIds(['aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee', 'bbbbbbbb-bbbb-1ccc-8ddd-eeeeeeeeeeee']))
      .to.be.rejectedWith('Permission denied');
    expect(deleted).to.be.empty;
  });
});
