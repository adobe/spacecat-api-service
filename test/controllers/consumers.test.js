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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
} from '../../src/utils/constants.js';
import { ErrorWithStatusCode } from '../../src/support/utils.js';

use(sinonChai);
use(chaiAsPromised);

describe('ConsumersController', () => {
  let ConsumersController;
  let context;
  let mockConsumer;
  let sandbox;

  function createMockConsumerEntity(overrides = {}) {
    const defaults = {
      consumerId: 'test-consumer-id',
      clientId: 'test-client-id',
      technicalAccountId: 'test-ta-id',
      imsOrgId: 'test-ims-org@AdobeOrg',
      consumerName: 'Test Integration',
      capabilities: ['site:read', 'site:write'],
      status: 'ACTIVE',
      revokedAt: null,
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
      ...overrides,
    };

    return {
      getConsumerId: () => defaults.consumerId,
      getClientId: () => defaults.clientId,
      getTechnicalAccountId: () => defaults.technicalAccountId,
      getImsOrgId: () => defaults.imsOrgId,
      getConsumerName: () => defaults.consumerName,
      getCapabilities: () => defaults.capabilities,
      getStatus: () => defaults.status,
      getRevokedAt: () => defaults.revokedAt,
      getCreatedAt: () => defaults.createdAt,
      getUpdatedAt: () => defaults.updatedAt,
      getUpdatedBy: () => defaults.updatedBy,
      setConsumerName: sinon.stub().callsFake((v) => { defaults.consumerName = v; }),
      setCapabilities: sinon.stub().callsFake((v) => { defaults.capabilities = v; }),
      setStatus: sinon.stub().callsFake((v) => { defaults.status = v; }),
      setRevokedAt: sinon.stub().callsFake((v) => { defaults.revokedAt = v; }),
      setUpdatedBy: sinon.stub().callsFake((v) => { defaults.updatedBy = v; }),
      save: sinon.stub().resolves(),
    };
  }

  const validTokenPayload = {
    valid: true,
    token: {
      client_id: 'test-client-id',
      user_id: 'test-ta-id',
      org: 'test-ims-org@AdobeOrg',
      type: 'access_token',
    },
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockConsumer = createMockConsumerEntity();

    context = {
      log: {
        error: sandbox.stub(),
        info: sandbox.stub(),
      },
      dataAccess: {
        Consumer: {
          all: sandbox.stub().resolves([mockConsumer]),
          findByClientId: sandbox.stub().resolves(mockConsumer),
          create: sandbox.stub().resolves(mockConsumer),
        },
      },
      imsClient: {
        validateAccessToken: sandbox.stub().resolves(validTokenPayload),
      },
      attributes: {
        authInfo: {
          getProfile: () => ({ email: 'admin@example.com', is_admin: true }),
        },
      },
    };

    const consumerModelMock = {
      Consumer: {
        STATUS: {
          ACTIVE: 'ACTIVE',
          SUSPENDED: 'SUSPENDED',
          REVOKED: 'REVOKED',
        },
      },
    };

    const slackMock = {
      BaseSlackClient: {
        createFrom: () => ({
          postMessage: sandbox.stub().resolves(),
        }),
      },
      SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
    };

    ConsumersController = (await esmock('../../src/controllers/consumers.js', {
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({
            hasS2SAdminAccess: () => true,
          }),
        },
      },
      '@adobe/spacecat-shared-data-access': consumerModelMock,
      '@adobe/spacecat-shared-slack-client': slackMock,
    })).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('throws if context is missing', () => {
      expect(() => ConsumersController(null)).to.throw('Context required');
    });

    it('throws if dataAccess is missing', () => {
      expect(() => ConsumersController({ log: console })).to.throw('Data access required');
    });
  });

  describe('getAll', () => {
    it('returns all consumers', async () => {
      const controller = ConsumersController(context);
      const response = await controller.getAll(context);
      const body = await response.json();

      expect(response.status).to.equal(STATUS_OK);
      expect(body).to.be.an('array').with.lengthOf(1);
      expect(body[0].clientId).to.equal('test-client-id');
      expect(body[0].consumerName).to.equal('Test Integration');
    });

    it('returns forbidden for non-admin users', async () => {
      const NonAdminController = (await esmock('../../src/controllers/consumers.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasS2SAdminAccess: () => false,
            }),
          },
        },
        '@adobe/spacecat-shared-data-access': {
          Consumer: { STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED' } },
        },
        '@adobe/spacecat-shared-slack-client': {
          BaseSlackClient: { createFrom: () => ({ postMessage: () => {} }) },
          SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
        },
      })).default;

      const controller = NonAdminController(context);
      const response = await controller.getAll(context);

      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });

    it('returns error when data access fails', async () => {
      context.dataAccess.Consumer.all.rejects(new Error('DB error'));
      const controller = ConsumersController(context);
      const response = await controller.getAll(context);

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });

  describe('getByClientId', () => {
    it('returns consumer by clientId', async () => {
      const controller = ConsumersController(context);
      const response = await controller.getByClientId({
        ...context,
        params: { clientId: 'test-client-id' },
      });
      const body = await response.json();

      expect(response.status).to.equal(STATUS_OK);
      expect(body.clientId).to.equal('test-client-id');
      expect(body.technicalAccountId).to.equal('test-ta-id');
    });

    it('returns 404 when consumer not found', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      const controller = ConsumersController(context);
      const response = await controller.getByClientId({
        ...context,
        params: { clientId: 'unknown-client' },
      });

      expect(response.status).to.equal(STATUS_NOT_FOUND);
    });

    it('returns bad request when clientId is empty', async () => {
      const controller = ConsumersController(context);
      const response = await controller.getByClientId({
        ...context,
        params: { clientId: '' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns error when data access fails', async () => {
      context.dataAccess.Consumer.findByClientId.rejects(new Error('DB error'));
      const controller = ConsumersController(context);
      const response = await controller.getByClientId({
        ...context,
        params: { clientId: 'test-client-id' },
      });

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });

  describe('register', () => {
    const validPayload = {
      accessToken: 'valid-ta-token',
      consumerName: 'Sites Internal Integration',
      capabilities: ['site:read', 'site:write'],
    };

    it('registers a new consumer', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });
      const body = await response.json();

      expect(response.status).to.equal(STATUS_CREATED);
      expect(body.clientId).to.equal('test-client-id');
      expect(body.status).to.equal('ACTIVE');
    });

    it('succeeds even when Slack notification fails', async () => {
      const SlackFailController = (await esmock('../../src/controllers/consumers.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasS2SAdminAccess: () => true,
            }),
          },
        },
        '@adobe/spacecat-shared-data-access': {
          Consumer: { STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED' } },
        },
        '@adobe/spacecat-shared-slack-client': {
          BaseSlackClient: {
            createFrom: () => ({
              postMessage: sandbox.stub().rejects(new Error('Slack is down')),
            }),
          },
          SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
        },
      })).default;

      context.dataAccess.Consumer.findByClientId.resolves(null);
      const controller = SlackFailController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_CREATED);
      expect(context.log.error).to.have.been.calledWithMatch(/Failed to send Slack notification/);
    });

    it('returns forbidden for non-admin users', async () => {
      const NonAdminController = (await esmock('../../src/controllers/consumers.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasS2SAdminAccess: () => false,
            }),
          },
        },
        '@adobe/spacecat-shared-data-access': {
          Consumer: { STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED' } },
        },
        '@adobe/spacecat-shared-slack-client': {
          BaseSlackClient: { createFrom: () => ({ postMessage: () => {} }) },
          SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
        },
      })).default;

      const controller = NonAdminController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });

    it('returns bad request when body is missing', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: null,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns bad request when accessToken is missing', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: { ...validPayload, accessToken: '' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('accessToken is required');
    });

    it('returns bad request when consumerName is missing', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: { ...validPayload, consumerName: '' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('consumerName is required');
    });

    it('returns bad request when capabilities is empty', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: { ...validPayload, capabilities: [] },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('capabilities must be a non-empty array');
    });

    it('returns bad request when capabilities is not an array', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: { ...validPayload, capabilities: 'not-an-array' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns bad request when access token validation fails', async () => {
      context.imsClient.validateAccessToken.rejects(new Error('Token invalid'));
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      const body = await response.json();
      expect(body.message).to.equal('Invalid or expired Technical Account access token');
    });

    it('returns bad request when validation response has no token data', async () => {
      context.imsClient.validateAccessToken.resolves({ valid: true });
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      const body = await response.json();
      expect(body.message).to.equal('IMS validation response does not contain token data');
    });

    it('returns bad request when validated payload is missing required fields', async () => {
      context.imsClient.validateAccessToken.resolves({
        valid: true,
        token: {
          client_id: 'test-client-id',
          user_id: '',
          org: '',
        },
      });
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('Technical Account identity');
    });

    it('returns bad request when consumer already exists', async () => {
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('already registered');
    });

    it('returns error when create fails unexpectedly', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      context.dataAccess.Consumer.create.rejects(new Error('Unexpected DB error'));
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });

    it('falls back to system when profile has no email', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      context.attributes.authInfo.getProfile = () => ({});
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_CREATED);
      expect(context.dataAccess.Consumer.create).to.have.been.calledWithMatch({
        updatedBy: 'system',
      });
    });

    it('defaults to 500 when ErrorWithStatusCode has no status', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      context.dataAccess.Consumer.create.rejects(new ErrorWithStatusCode('No status set'));
      const controller = ConsumersController(context);
      const response = await controller.register({
        ...context,
        data: validPayload,
      });

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
      expect(response.headers.get('x-error')).to.equal('No status set');
    });
  });

  describe('update', () => {
    it('updates consumer name', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { consumerName: 'Updated Name' },
      });
      const body = await response.json();

      expect(response.status).to.equal(STATUS_OK);
      expect(body.consumerName).to.equal('Updated Name');
      expect(mockConsumer.setConsumerName).to.have.been.calledWith('Updated Name');
      expect(mockConsumer.save).to.have.been.calledOnce;
    });

    it('updates consumer capabilities', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { capabilities: ['site:read'] },
      });

      expect(response.status).to.equal(STATUS_OK);
      expect(mockConsumer.setCapabilities).to.have.been.calledWith(['site:read']);
    });

    it('rejects revokedAt in update payload', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { revokedAt: '2026-12-31T23:59:59.000Z' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('revokedAt');
      expect(response.headers.get('x-error')).to.include('revoke endpoint');
    });

    it('updates consumer status to SUSPENDED', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { status: 'SUSPENDED' },
      });

      expect(response.status).to.equal(STATUS_OK);
      expect(mockConsumer.setStatus).to.have.been.calledWith('SUSPENDED');
    });

    it('rejects REVOKED status in update payload', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { status: 'REVOKED' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('Invalid status for update');
    });

    it('blocks updates on a revoked consumer', async () => {
      const revokedConsumer = createMockConsumerEntity({ status: 'REVOKED' });
      context.dataAccess.Consumer.findByClientId.resolves(revokedConsumer);
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { consumerName: 'New Name' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Cannot update a revoked consumer');
    });

    it('rejects immutable field clientId', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { clientId: 'new-client-id' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('immutable');
      expect(response.headers.get('x-error')).to.include('clientId');
    });

    it('rejects immutable field technicalAccountId', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { technicalAccountId: 'new-ta-id' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('technicalAccountId');
    });

    it('rejects immutable field imsOrgId', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { imsOrgId: 'new-org@AdobeOrg' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.include('imsOrgId');
    });

    it('rejects multiple immutable fields at once', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { clientId: 'x', technicalAccountId: 'y', imsOrgId: 'z' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      const errorMsg = response.headers.get('x-error');
      expect(errorMsg).to.include('clientId');
      expect(errorMsg).to.include('technicalAccountId');
      expect(errorMsg).to.include('imsOrgId');
    });

    it('returns 404 when consumer not found', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'unknown' },
        data: { consumerName: 'New Name' },
      });

      expect(response.status).to.equal(STATUS_NOT_FOUND);
    });

    it('returns bad request when clientId is empty', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: '' },
        data: { consumerName: 'New Name' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('clientId is required');
    });

    it('returns bad request when body is missing', async () => {
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: null,
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns forbidden for non-admin users', async () => {
      const NonAdminController = (await esmock('../../src/controllers/consumers.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasS2SAdminAccess: () => false,
            }),
          },
        },
        '@adobe/spacecat-shared-data-access': {
          Consumer: { STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED' } },
        },
        '@adobe/spacecat-shared-slack-client': {
          BaseSlackClient: { createFrom: () => ({ postMessage: () => {} }) },
          SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
        },
      })).default;

      const controller = NonAdminController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { consumerName: 'New Name' },
      });

      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });

    it('returns error when save fails', async () => {
      mockConsumer.save.rejects(new Error('Save failed'));
      const controller = ConsumersController(context);
      const response = await controller.update({
        ...context,
        params: { clientId: 'test-client-id' },
        data: { consumerName: 'New Name' },
      });

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });

  describe('revoke', () => {
    it('revokes a consumer', async () => {
      const controller = ConsumersController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: 'test-client-id' },
      });
      const body = await response.json();

      expect(response.status).to.equal(STATUS_OK);
      expect(mockConsumer.setStatus).to.have.been.calledWith('REVOKED');
      expect(mockConsumer.setRevokedAt).to.have.been.calledOnce;
      expect(mockConsumer.save).to.have.been.calledOnce;
      expect(body.status).to.equal('REVOKED');
    });

    it('returns bad request when consumer is already revoked', async () => {
      const revokedConsumer = createMockConsumerEntity({ status: 'REVOKED' });
      context.dataAccess.Consumer.findByClientId.resolves(revokedConsumer);
      const controller = ConsumersController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: 'test-client-id' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Consumer is already revoked');
    });

    it('returns 404 when consumer not found', async () => {
      context.dataAccess.Consumer.findByClientId.resolves(null);
      const controller = ConsumersController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: 'unknown' },
      });

      expect(response.status).to.equal(STATUS_NOT_FOUND);
    });

    it('returns bad request when clientId is empty', async () => {
      const controller = ConsumersController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: '' },
      });

      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('returns forbidden for non-admin users', async () => {
      const NonAdminController = (await esmock('../../src/controllers/consumers.js', {
        '../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({
              hasS2SAdminAccess: () => false,
            }),
          },
        },
        '@adobe/spacecat-shared-data-access': {
          Consumer: { STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED' } },
        },
        '@adobe/spacecat-shared-slack-client': {
          BaseSlackClient: { createFrom: () => ({ postMessage: () => {} }) },
          SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
        },
      })).default;

      const controller = NonAdminController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: 'test-client-id' },
      });

      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });

    it('returns error when save fails', async () => {
      mockConsumer.save.rejects(new Error('Save failed'));
      const controller = ConsumersController(context);
      const response = await controller.revoke({
        ...context,
        params: { clientId: 'test-client-id' },
      });

      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });
});
