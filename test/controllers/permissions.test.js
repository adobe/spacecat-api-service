/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);

const SITE_ID = '11111111-2222-4333-9444-555555555555';
const BRAND_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
const IMS_ORG = 'CUST-ORG-001@AdobeOrg';
const CALLER_SUB = 'user-abc@AdobeID';

function makeSite() {
  const org = {
    getId: () => 'org-internal-id',
    getImsOrgId: () => IMS_ORG,
  };
  return {
    getId: () => SITE_ID,
    getOrganizationId: () => 'org-internal-id',
    getOrganization: async () => org,
  };
}

function makeContext({
  product = 'LLMO',
  siteId = SITE_ID,
  body,
  callerSub = CALLER_SUB,
  site = makeSite(),
} = {}) {
  return {
    log: {
      debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
    },
    attributes: {
      authInfo: { getProfile: () => ({ sub: callerSub }) },
    },
    data: body,
    params: { siteId },
    pathInfo: { headers: product ? { 'x-product': product } : {} },
    dataAccess: {
      services: { postgrestClient: { from: () => {} } },
      Site: { findById: sinon.stub().resolves(site) },
    },
  };
}

async function loadController({
  validateEntitlement = sinon.stub().resolves(),
  brandIds = new Set([BRAND_ID]),
  capableBrandIds = new Set([BRAND_ID]),
  requirePostgrest = () => null,
} = {}) {
  class FakeAccessControlUtil {
    // eslint-disable-next-line class-methods-use-this
    validateEntitlement(...args) { return validateEntitlement(...args); }
  }
  const mod = await esmock('../../src/controllers/permissions.js', {
    '../../src/support/access-control-util.js': { default: FakeAccessControlUtil },
    '../../src/support/brands-storage.js': {
      listBrandIdsForSite: sinon.stub().resolves(brandIds),
    },
    '../../src/support/state-access-mapping-utils.js': {
      listResourceIdsWithCapability: sinon.stub().resolves(capableBrandIds),
      requirePostgrestForFacsMappings: requirePostgrest,
    },
  });
  return { Controller: mod.default, validateEntitlement };
}

describe('PermissionsController', () => {
  describe('checkSitePermission', () => {
    it('503 when postgrest is unavailable', async () => {
      const { Controller } = await loadController({ requirePostgrest: () => ({ status: 503 }) });
      const ctx = makeContext();
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(503);
    });

    it('400 when x-product header is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: null });
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(400);
    });

    it('400 when siteId is not a UUID', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ siteId: 'not-a-uuid' });
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(400);
    });

    it('404 when the site does not exist', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ site: null });
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(404);
    });

    it('allowed:true when entitlement passes and the brand holds the grant', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext();
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.allowed).to.equal(true);
      expect(body.reason).to.equal('granted');
      expect(body.capability).to.equal('llmo/can_deploy');
    });

    it('allowed:false (entitlement_denied) when validateEntitlement throws', async () => {
      const { Controller } = await loadController({
        validateEntitlement: sinon.stub().rejects(new Error('Unauthorized request')),
      });
      const ctx = makeContext();
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.allowed).to.equal(false);
      expect(body.reason).to.equal('entitlement_denied');
    });

    it('allowed:false (no_brand_for_site) when the site has no brand', async () => {
      const { Controller } = await loadController({ brandIds: new Set() });
      const ctx = makeContext();
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(body.allowed).to.equal(false);
      expect(body.reason).to.equal('no_brand_for_site');
    });

    it('allowed:false (capability_not_granted) when no brand holds the grant', async () => {
      const { Controller } = await loadController({ capableBrandIds: new Set() });
      const ctx = makeContext();
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(body.allowed).to.equal(false);
      expect(body.reason).to.equal('capability_not_granted');
    });

    it('honours a fully-qualified capability from the body', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { capability: 'llmo/can_configure' } });
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(body.capability).to.equal('llmo/can_configure');
    });

    it('qualifies a bare capability with the product prefix', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { capability: 'can_configure' } });
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(body.capability).to.equal('llmo/can_configure');
    });

    it('400 when x-product is present but not a known product', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: 'NOPE' });
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(400);
    });

    it('404 when the site has no organization', async () => {
      const { Controller } = await loadController();
      const siteNoOrg = {
        getId: () => SITE_ID,
        getOrganizationId: () => 'org-internal-id',
        getOrganization: async () => null,
      };
      const ctx = makeContext({ site: siteNoOrg });
      const res = await Controller(ctx).checkSitePermission(ctx);
      expect(res.status).to.equal(404);
    });

    it('resolves with only the org subject scope when the caller has no sub', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ callerSub: null });
      const res = await Controller(ctx).checkSitePermission(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.allowed).to.equal(true);
    });
  });
});
