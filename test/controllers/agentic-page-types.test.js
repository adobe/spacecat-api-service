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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import AgenticPageTypesController from '../../src/controllers/agentic-page-types.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(sinonChai);

// agentic-page-types is a thin wrapper over the same factory used by
// agentic-categories. Deep behaviour coverage lives in agentic-categories.test.js;
// here we just verify the wrapper exposes all handlers and routes operations to
// the page-type table (not the category table).

const SITE_ID = '0178a3f0-1234-7000-8000-000000000001';
const PAGE_TYPE_TABLE = 'agentic_url_page_type_rules';

function buildClient() {
  const tablesQueried = [];
  function chain() {
    const c = {};
    c.select = () => c;
    c.insert = () => c;
    c.update = () => c;
    c.delete = () => c;
    c.eq = () => c;
    c.limit = () => c;
    c.order = () => Promise.resolve({ data: [], error: null });
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.single = () => Promise.resolve({ data: null, error: null });
    return c;
  }
  return {
    from: (table) => {
      tablesQueried.push(table);
      return chain();
    },
    tablesQueried,
  };
}

function buildContext({ client }) {
  return {
    params: { siteId: SITE_ID },
    data: {},
    attributes: {
      authInfo: new AuthInfo().withType('jwt').withProfile({ user_id: 'u' }).withAuthenticated(true),
    },
    dataAccess: {
      Site: { findById: sinon.stub().resolves({ getId: () => SITE_ID }) },
      services: { postgrestClient: client },
    },
    log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
  };
}

function loadController(mockHasAccess = sinon.stub().resolves(true)) {
  if (AccessControlUtil.fromContext.restore) {
    AccessControlUtil.fromContext.restore();
  }
  sinon.stub(AccessControlUtil, 'fromContext').returns({
    hasAccess: mockHasAccess,
    hasAdminAccess: sinon.stub().returns(false),
  });
  return AgenticPageTypesController();
}

describe('AgenticPageTypesController', () => {
  afterEach(() => sinon.restore());

  it('exposes four handlers', () => {
    const controller = loadController();
    expect(controller.list).to.be.a('function');
    expect(controller.create).to.be.a('function');
    expect(controller.update).to.be.a('function');
    expect(controller.remove).to.be.a('function');
  });

  it('list queries the page-type table', async () => {
    const client = buildClient();
    const controller = loadController();
    const res = await controller.list(buildContext({ client }));
    expect(res.status).to.equal(200);
    expect(client.tablesQueried).to.include(PAGE_TYPE_TABLE);
    expect(client.tablesQueried).to.not.include('agentic_url_category_rules');
  });

  it('returns 403 when access denied', async () => {
    const client = buildClient();
    const controller = loadController(sinon.stub().resolves(false));
    const res = await controller.list(buildContext({ client }));
    expect(res.status).to.equal(403);
    // Auth must short-circuit before any DB query.
    expect(client.tablesQueried).to.have.length(0);
  });
});
