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

  let validateReadAccess;
  let accessControlUtil;
  let postgrestClient;
  let context;

  beforeEach(() => {
    validateReadAccess = sandbox.stub().resolves();
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
      validateReadAccess.rejects(new Error('Only admins or users with LLMO organization access can view global agentic traffic'));
      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);

      const response = await handler(context);

      expect(response.status).to.equal(403);
      expect(postgrestClient.from).not.to.have.been.called;
    });

    it('uses the default forbidden message when read access validation error has no message', async () => {
      validateReadAccess.rejects({});
      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);

      const response = await handler(context);

      expect(response.status).to.equal(403);
      expect((await response.json()).message)
        .to.equal('Only admins or users with LLMO organization access can view global agentic traffic');
    });

    it('uses the provided read access validator before querying PostgREST', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(validateReadAccess).to.have.been.calledWith(context);
      expect(thenable.limit).to.have.been.calledWith(52);
      expect(await response.json()).to.deep.equal([]);
    });

    it('returns 503 when PostgREST is unavailable', async () => {
      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);

      const response = await handler({
        ...context,
        dataAccess: { services: {} },
      });

      expect(response.status).to.equal(503);
    });

    it('returns bad request for invalid limit', async () => {
      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);

      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'limit=0' } },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('limit must be greater than or equal to 1');
    });

    it('returns bad request for non-integer week query param', async () => {
      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);

      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'week=abc' } },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('week must be an integer');
    });

    it('treats query params without a value as empty strings', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'year' } },
      });

      expect(response.status).to.equal(200);
      expect(thenable.eq).not.to.have.been.called;
      expect(thenable.limit).to.have.been.calledWith(52);
      expect(await response.json()).to.deep.equal([]);
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

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
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

    it('applies the week filter when provided', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
      const response = await handler({
        ...context,
        invocation: { event: { rawQueryString: 'year=2026&week=14' } },
      });

      expect(response.status).to.equal(200);
      expect(thenable.eq).to.have.been.calledWith('week', 14);
      expect(thenable.limit).to.have.been.calledWith(52);
      expect(await response.json()).to.deep.equal([]);
    });

    it('returns an empty array when PostgREST returns no rows', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(thenable.limit).to.have.been.calledWith(52);
      expect(await response.json()).to.deep.equal([]);
    });

    it('returns internal server error when PostgREST responds with an error', async () => {
      const thenable = {
        then: (resolve) => Promise.resolve({
          data: null,
          error: { message: 'boom' },
        }).then(resolve),
      };
      thenable.select = sandbox.stub().returns(thenable);
      thenable.order = sandbox.stub().returns(thenable);
      thenable.eq = sandbox.stub().returns(thenable);
      thenable.limit = sandbox.stub().returns(thenable);
      postgrestClient.from.returns(thenable);

      const handler = createAgenticTrafficGlobalGetHandler(validateReadAccess);
      const response = await handler(context);

      expect(response.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWith('Error listing global agentic traffic: boom');
      expect((await response.json()).message).to.equal('Failed to list global agentic traffic');
    });
  });

  describe('POST handler', () => {
    it('returns forbidden for non-admin access', async () => {
      accessControlUtil.hasAdminAccess.returns(false);
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('allows S2S consumers that already passed route capability validation', async () => {
      accessControlUtil.hasAdminAccess.returns(false);
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: {
              id: 'row-s2s',
              year: 2026,
              week: 18,
              hits: 456,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-02T00:00:00Z',
              updated_by: 'spacecat-api-service',
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
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_s2s_consumer: true, client_id: 'client-1' })
            .withAuthenticated(true),
        },
        s2sConsumer: { getCapabilities: () => ['report:write'] },
        data: { year: 2026, week: 18, hits: 456 },
      });

      expect(response.status).to.equal(200);
      expect(upsertStub).to.have.been.calledWith({
        year: 2026,
        week: 18,
        hits: 456,
        updated_by: 'spacecat-api-service',
      }, { onConflict: 'year,week' });
    });

    it('returns 503 when PostgREST is unavailable', async () => {
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler({
        ...context,
        dataAccess: { services: {} },
      });

      expect(response.status).to.equal(503);
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

    it('returns bad request when year is missing', async () => {
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler({
        ...context,
        data: { week: 14, hits: 10 },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('year is required');
    });

    it('returns bad request for non-integer hits', async () => {
      const handler = createAgenticTrafficGlobalPostHandler(accessControlUtil);

      const response = await handler({
        ...context,
        data: { year: 2026, week: 14, hits: 'many' },
      });

      expect(response.status).to.equal(400);
      expect((await response.json()).message).to.equal('hits must be an integer');
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

    it('uses profile sub when user_id is missing', async () => {
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: {
              id: 'row-2',
              year: 2026,
              week: 15,
              hits: 200,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-02T00:00:00Z',
              updated_by: 'sub-9',
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
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true, sub: 'sub-9' })
            .withAuthenticated(true),
        },
        data: { year: 2026, week: 15, hits: 200 },
      });

      expect(response.status).to.equal(200);
      expect(upsertStub).to.have.been.calledWithMatch({
        updated_by: 'sub-9',
      });
    });

    it('falls back to service name when auth profile has no user_id or sub', async () => {
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: {
              id: 'row-3',
              year: 2026,
              week: 16,
              hits: 300,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-02T00:00:00Z',
              updated_by: 'spacecat-api-service',
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
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
        data: { year: 2026, week: 16, hits: 300 },
      });

      expect(response.status).to.equal(200);
      expect(upsertStub).to.have.been.calledWithMatch({
        updated_by: 'spacecat-api-service',
      });
    });

    it('uses authInfo.profile when getProfile is unavailable', async () => {
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: {
              id: 'row-4',
              year: 2026,
              week: 17,
              hits: 400,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-02T00:00:00Z',
              updated_by: 'profile-sub',
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
        attributes: {
          authInfo: {
            profile: { sub: 'profile-sub' },
          },
        },
        data: { year: 2026, week: 17, hits: 400 },
      });

      expect(response.status).to.equal(200);
      expect(upsertStub).to.have.been.calledWithMatch({
        updated_by: 'profile-sub',
      });
    });

    it('returns internal server error when upsert responds with an error', async () => {
      const upsertStub = sandbox.stub().returns({
        select: sandbox.stub().returns({
          single: sandbox.stub().resolves({
            data: null,
            error: { message: 'insert failed' },
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

      expect(response.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWith('Error upserting global agentic traffic: insert failed');
      expect((await response.json()).message).to.equal('Failed to update global agentic traffic');
    });
  });
});
