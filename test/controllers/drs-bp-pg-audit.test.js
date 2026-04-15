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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';

import DrsBpPgAuditController from '../../src/controllers/drs-bp-pg-audit.js';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_SERVER_ERROR,
} from '../../src/utils/constants.js';

use(sinonChai);
use(chaiAsPromised);

const VALID_SITE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const VALID_PARAMS = {
  siteId: VALID_SITE_ID,
  dateStart: '2025-04-14',
  dateEnd: '2025-04-15',
};

describe('DrsBpPgAuditController tests', () => {
  let context;
  let controller;
  let postgrestFromStub;
  let queryChain;

  const sampleRows = [
    {
      correlation_id: 'corr-1',
      scope_prefix: VALID_SITE_ID,
      output_count: 42,
      metadata: {},
      projected_at: '2025-04-14T10:00:00Z',
    },
    {
      correlation_id: 'corr-2',
      scope_prefix: VALID_SITE_ID,
      output_count: 38,
      metadata: {},
      projected_at: '2025-04-14T09:00:00Z',
    },
  ];

  beforeEach(() => {
    queryChain = {
      select: sinon.stub().returnsThis(),
      eq: sinon.stub().returnsThis(),
      gte: sinon.stub().returnsThis(),
      lt: sinon.stub().returnsThis(),
      order: sinon.stub().returnsThis(),
      range: sinon.stub().resolves({ data: sampleRows, error: null }),
    };

    postgrestFromStub = sinon.stub().returns(queryChain);

    context = {
      log: console,
      dataAccess: {
        services: {
          postgrestClient: {
            from: postgrestFromStub,
          },
        },
      },
    };

    controller = DrsBpPgAuditController();
  });

  afterEach(() => sinon.restore());

  function makeCtx(params, overrides = {}) {
    return { params, dataAccess: context.dataAccess, ...overrides };
  }

  describe('getProjectionAudit', () => {
    // ── Validation: auth / client availability ──

    it('returns 500 when postgrestClient is not available', async () => {
      const ctrl = DrsBpPgAuditController();
      const resp = await ctrl.getProjectionAudit({
        params: VALID_PARAMS,
        dataAccess: { services: {} },
      });
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });

    // ── Validation: required params ──

    it('returns 400 when siteId is missing', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ dateStart: '2025-04-14', dateEnd: '2025-04-15' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when siteId is not a valid UUID', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, siteId: 'not-a-uuid' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateStart is missing', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ siteId: VALID_SITE_ID, dateEnd: '2025-04-15' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateStart has invalid format', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, dateStart: '14-04-2025' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateEnd is missing', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ siteId: VALID_SITE_ID, dateStart: '2025-04-14' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateEnd has invalid format', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, dateEnd: 'April-15-2025' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateEnd is not after dateStart', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ siteId: VALID_SITE_ID, dateStart: '2025-04-15', dateEnd: '2025-04-14' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns 400 when dateEnd equals dateStart', async () => {
      const resp = await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, dateEnd: '2025-04-14' }));
      expect(resp.status).to.equal(STATUS_BAD_REQUEST);
    });

    // ── Success: response shape ──

    it('returns 200 with rows and hasMore=false on success', async () => {
      const resp = await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body.rows).to.deep.equal(sampleRows);
      expect(body.hasMore).to.equal(false);
    });

    it('returns hasMore=true when a full page of rows is returned', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) => ({ correlation_id: `c-${i}` }));
      queryChain.range.resolves({ data: fullPage, error: null });
      const resp = await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body.rows).to.have.lengthOf(500);
      expect(body.hasMore).to.equal(true);
    });

    it('returns empty rows array and hasMore=false when data is null', async () => {
      queryChain.range.resolves({ data: null, error: null });
      const resp = await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(resp.status).to.equal(STATUS_OK);
      const body = await resp.json();
      expect(body.rows).to.deep.equal([]);
      expect(body.hasMore).to.equal(false);
    });

    // ── Query construction ──

    it('queries with default handler_name when not specified', async () => {
      await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(postgrestFromStub).to.have.been.calledWith('projection_audit');
      expect(queryChain.eq).to.have.been.calledWith('handler_name', 'wrpc_import_brand_presence');
    });

    it('passes custom handler_name when provided', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, handlerName: 'custom_handler' }));
      expect(queryChain.eq).to.have.been.calledWith('handler_name', 'custom_handler');
    });

    it('applies correct date range filters', async () => {
      await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(queryChain.gte).to.have.been.calledWith('projected_at', '2025-04-14T00:00:00Z');
      expect(queryChain.lt).to.have.been.calledWith('projected_at', '2025-04-15T00:00:00Z');
    });

    // ── Limit / offset ──

    it('clamps limit to 500 even if larger value is requested', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, limit: '9999' }));
      expect(queryChain.range).to.have.been.calledWith(0, 499);
    });

    it('defaults limit to 500 when non-numeric limit is provided', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, limit: 'notanumber' }));
      expect(queryChain.range).to.have.been.calledWith(0, 499);
    });

    it('floors limit to 1 when limit=0 is provided', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, limit: '0' }));
      expect(queryChain.range).to.have.been.calledWith(0, 0);
    });

    it('passes offset to range', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, offset: '500' }));
      expect(queryChain.range).to.have.been.calledWith(500, 999);
    });

    it('defaults offset to 0 when not provided', async () => {
      await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(queryChain.range).to.have.been.calledWith(0, 499);
    });

    it('defaults offset to 0 when non-numeric offset is provided', async () => {
      await controller.getProjectionAudit(makeCtx({ ...VALID_PARAMS, offset: 'notanumber' }));
      expect(queryChain.range).to.have.been.calledWith(0, 499);
    });

    // ── Error handling ──

    it('returns 500 when postgrest query returns an error', async () => {
      queryChain.range.resolves({ data: null, error: { message: 'DB connection failed' } });
      const resp = await controller.getProjectionAudit(makeCtx(VALID_PARAMS));
      expect(resp.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });

    it('does not leak postgrest error message in 500 response body', async () => {
      queryChain.range.resolves({ data: null, error: { message: 'internal schema details' } });
      const resp = await controller.getProjectionAudit(
        makeCtx(VALID_PARAMS, { log: { error: sinon.stub() } }),
      );
      const body = await resp.json();
      expect(JSON.stringify(body)).to.not.include('internal schema details');
    });
  });
});
