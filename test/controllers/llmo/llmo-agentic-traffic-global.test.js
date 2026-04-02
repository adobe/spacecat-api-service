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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import {
  createAgenticTrafficGlobalGetHandler,
  createAgenticTrafficGlobalPostHandler,
} from '../../../src/controllers/llmo/llmo-agentic-traffic-global.js';

use(sinonChai);

describe('llmo-agentic-traffic-global', () => {
  const sandbox = sinon.createSandbox();

  let accessControlUtil;
  let postgrestClient;
  let context;

  beforeEach(() => {
    accessControlUtil = {
      hasAdminAccess: sandbox.stub().returns(true),
    };

    postgrestClient = {
      from: sandbox.stub(),
    };

    context = {
      data: {},
      invocation: { event: {} },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true, user_id: 'user-1' })
          .withAuthenticated(true),
      },
      dataAccess: {
        services: {
          postgrestClient,
        },
      },
      log: {
        error: sandbox.stub(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('GET handler', () => {
    it('returns forbidden for non-admin access', async () => {
      accessControlUtil.hasAdminAccess.returns(false);
      const handler = createAgenticTrafficGlobalGetHandler(accessControlUtil);

      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns 503 when PostgREST is unavailable', async () => {
      const handler = createAgenticTrafficGlobalGetHandler(accessControlUtil);

      const response = await handler({
        ...context,
        dataAccess: { services: {} },
      });

      expect(response.status).to.equal(503);
    });

    it('returns bad request for invalid limit', async () => {
      const handler = createAgenticTrafficGlobalGetHandler(accessControlUtil);

      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'limit=0' } },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('limit must be greater than or equal to 1');
    });

    it('lists global traffic rows ordered by newest week', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({
          data: [{
            id: 'row-1',
            year: 2026,
            week: 14,
            hits: 12345,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-02T00:00:00Z',
            updated_by: 'system',
          }],
          error: null,
        }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(accessControlUtil);
      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'year=2026&limit=10' } },
      });

      expect(response.status).to.equal(200);
      expect(postgrestClient.from).to.have.been.calledWith('agentic_traffic_global');
      expect(thenable.eq).to.have.been.calledWith('year', 2026);
      expect(thenable.limit).to.have.been.calledWith(10);
      expect(await response.json()).to.deep.equal([{
        id: 'row-1',
        year: 2026,
        week: 14,
        hits: 12345,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        updatedBy: 'system',
      }]);
    });
  });

  describe('POST handler', () => {
    it('returns forbidden for non-admin access', async () => {
      accessControlUtil.hasAdminAccess.returns(false);
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns bad request when body is not an object', async () => {
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler({
        ...context,
        data: [],
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('Request body must be an object');
    });

    it('returns bad request for invalid week', async () => {
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler({
        ...context,
        data: { year: 2026, week: 54, hits: 10 },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('week must be less than or equal to 53');
    });

    it('upserts a weekly row and returns the normalized payload', async () => {
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: {
              id: 'row-1',
              year: 2026,
              week: 14,
              hits: 12345,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-02T00:00:00Z',
              updated_by: 'user-1',
            },
            error: null,
          }),
        }),
      });
      postgrestClient.from.returns({
        upsert: upsertStub,
      });

      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);
      const response = await handler({
        ...context,
        data: { year: 2026, week: 14, hits: 12345 },
      });

      expect(response.status).to.equal(200);
      expect(upsertStub).to.have.been.calledWith({
        year: 2026,
        week: 14,
        hits: 12345,
        updated_by: 'user-1',
      }, { onConflict: 'year,week' });
      expect(await response.json()).to.deep.equal({
        id: 'row-1',
        year: 2026,
        week: 14,
        hits: 12345,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        updatedBy: 'user-1',
      });
    });
  });
});
