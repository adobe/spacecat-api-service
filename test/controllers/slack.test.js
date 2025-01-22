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

import { Response } from '@adobe/fetch';

import { use, expect } from 'chai';
import nock from 'nock';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';

import SlackController from '../../src/controllers/slack.js';

use(sinonChai);
use(chaiAsPromised);

describe('SlackController', () => {
  let testPayload;
  let mockDataAccess;
  let mockSlackApp;
  let context;
  let logStub;
  let processEventStub;
  let middlewares;
  let mockOrgObject;

  const mockConfig = {
    getSlackConfig: () => ({
      channel: 'mock-channel-id',
    }),
  };

  function createMockSlackApp(processEventHandler) {
    class MockSlackApp {
      constructor(opts) {
        this.event = sinon.stub();
        this.action = sinon.stub();
        this.use = (middleware) => {
          middlewares.push(middleware);
        };
        this.processEvent = processEventHandler || sinon.stub().resolves();

        // for coverage, no-op
        opts.logger.getLevel();
        opts.logger.setLevel();
      }
    }

    return MockSlackApp;
  }

  beforeEach(() => {
    middlewares = [];
    processEventStub = sinon.stub().resolves();
    mockSlackApp = createMockSlackApp(processEventStub);
    logStub = {
      level: 'info',
      debug: sinon.stub(),
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };
    testPayload = { type: 'event_callback', event: {} };

    mockOrgObject = {
      getId: () => 'mock-id',
      getName: () => 'Test org #1',
      getImsOrgId: () => '1234567890ABCDEF12345678@AdobeOrg',
      getConfig: () => mockConfig,
    };

    context = {
      env: {
        SLACK_BOT_TOKEN: 'test-bot-token',
        SLACK_SIGNING_SECRET: 'test-signing-secret',
      },
      log: logStub,
      data: testPayload,
      pathInfo: { headers: {} },
    };

    mockDataAccess = {
      Configuration: {
        findLatest: sinon.stub().resolves(mockConfig),
      },
      Organization: {
        findByImsOrgId: sinon.stub().resolves(mockOrgObject),
      },
    };
    context.dataAccess = mockDataAccess;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('handleEvent', () => {
    it('throws error when slack signing secret is missing', async () => {
      delete context.env.SLACK_SIGNING_SECRET;

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(response.status).to.equal(500);
      expect(response.headers.plain()['x-error']).to.equal(
        'Missing SLACK_SIGNING_SECRET',
      );
    });

    it('throws error when slack bot token is missing', async () => {
      delete context.env.SLACK_BOT_TOKEN;

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(response.status).to.equal(500);
      expect(response.headers.plain()['x-error']).to.equal(
        'Missing SLACK_BOT_TOKEN',
      );
    });

    it('responds to URL verification', async () => {
      context.data = { type: 'url_verification', challenge: 'challenge_token' };

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);
      const json = await response.json();

      expect(response).to.be.an.instanceof(Response);
      expect(json).to.deep.equal({ challenge: 'challenge_token' });
    });

    it('ignores retry events due to http_timeout', async () => {
      context.pathInfo.headers['x-slack-retry-reason'] = 'http_timeout';
      context.data = { event_id: '123' };

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(logStub.info.calledWith('Ignoring retry event: 123')).to.be.true;
      expect(response).to.be.an.instanceof(Response);
      expect(response.headers.get('x-error')).to.equal('ignored-event');
    });

    it('does not initialize the slack bot if it already exists', async () => {
      context.boltApp = {
        processEvent: processEventStub,
        prexisiting: true,
      };

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(context.boltApp).to.have.property('prexisiting').that.is.true;
      expect(response.status).to.equal(200);
    });

    it('initializes the slack bot', async () => {
      delete context.boltApp;

      nock('https://slack.com', {
        reqheaders: {
          authorization: `Bearer ${context.env.SLACK_BOT_TOKEN}`,
        },
      })
        .post('/api/auth.test')
        .reply(200, {
          ok: true,
          ts: '123',
        });

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(context.boltApp).to.not.be.undefined;
      expect(context.boltApp).to.have.property('use');
      expect(context.boltApp).to.have.property('event');
      expect(context.boltApp).to.have.property('processEvent');

      await middlewares[0]({ context, next: () => true });

      expect(response.status).to.equal(200);
    });

    it('processes normal Slack events correctly', async () => {
      processEventStub = sinon.stub().callsFake((event) => {
        expect(event.body).to.deep.equal(testPayload);
        expect(event.ack).to.be.a('function');
        event.ack();
      });

      mockSlackApp = createMockSlackApp(processEventStub);

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(processEventStub.calledOnce).to.be.true;
      expect(processEventStub.firstCall.firstArg.body).to.deep.equal(
        testPayload,
      );
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(200);
    });

    it('processes Slack events with data payload', async () => {
      context.data.payload = '{ "test": "payload" }';

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(processEventStub.calledOnce).to.be.true;
      expect(processEventStub.firstCall.firstArg.body).to.deep.equal(
        { test: 'payload' },
      );
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(200);
    });

    it('handles errors during event processing', async () => {
      const testError = new Error('Test error');

      processEventStub.rejects(testError);
      mockSlackApp = createMockSlackApp(processEventStub);

      const controller = SlackController(mockSlackApp);
      const response = await controller.handleEvent(context);

      expect(processEventStub.calledOnce).to.be.true;
      expect(processEventStub.firstCall.firstArg.body).to.deep.equal(
        testPayload,
      );
      expect(logStub.error.calledWith(
        `Error processing event: ${testError.message}`,
      )).to.be.true;
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal(testError.message);
    });
  });

  describe('inviteUserToChannel', () => {
    let controller;

    beforeEach(() => {
      controller = SlackController(mockSlackApp);
      const mockImsClient = {
        getImsUserProfile: sinon.stub().resolves({
          userId: '9876547890ABCDEF12345678@abcdef123456789.e',
          email: 'mock-user@example.com',
          organizations: ['1234567890ABCDEF12345678@AdobeOrg'],
        }),
      };
      context.imsClient = mockImsClient;

      context.slack = {};

      context.data = {
        imsUserAccessToken: 'mock-token',
        imsOrgId: '1234567890ABCDEF12345678@AdobeOrg',
      };
    });

    it('throws error when IMS client fails to fetch the user profile', async () => {
      context.imsClient = {
        getImsUserProfile: sinon.stub().rejects(new Error('IMS getImsUserProfile request failed with status: 401')),
      };

      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(404);
      expect(response.headers.plain()['x-error']).to.equal('Error fetching user profile with the given access token.');
    });

    it('throws error when the user profile response does not include the requested IMS org ID', async () => {
      context.data = {
        imsUserAccessToken: 'mock-token',
        // User is requesting access to this org's Slack channel
        // Note that this value is not inlcuded in the organizations array above
        imsOrgId: '9988776690ABCDEF12345678@AdobeOrg',
      };

      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('User is not a member of the given organization.');
    });

    it('throws error when there is no Star Catalogue entry for the requested IMS org ID', async () => {
      mockDataAccess.Organization.findByImsOrgId = sinon.stub().resolves(null);

      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(404);
      expect(response.headers.plain()['x-error']).to.equal('Error reading organization: not found.');
    });

    it('should not find a Slack channel for the given organization', async () => {
      mockOrgObject.getConfig = sinon.stub().returns({ getSlackConfig: () => ({}) });
      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(404);
      expect(response.headers.plain()['x-error']).to.equal('Slack channel not found for this organization.');
    });

    it('fails to invite the user to their orgs Slack channel', async () => {
      context.slack.elevatedClient = {
        inviteUsersByEmail: sinon.stub().rejects(new Error('Slack inviteUsersByEmail request failed with status: 401')),
      };
      const orgWithSlackConfig = {
        ...mockOrgObject,
        ...mockConfig,
      };
      mockDataAccess.Organization.findByImsOrgId.resolves(orgWithSlackConfig);

      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(500);
      expect(response.headers.plain()['x-error']).to.equal('Error inviting user to Slack channel.');
    });

    it('should succeed at inviting the user to the Slack channel', async () => {
      const orgWithSlackConfig = {
        ...mockOrgObject,
        ...mockConfig,
      };
      mockDataAccess.Organization.findByImsOrgId.resolves(orgWithSlackConfig);

      let validatedSlackCall = false;
      context.slack.elevatedClient = {
        inviteUsersByEmail: async (channelId, users) => {
          expect(channelId).to.equal('mock-channel-id');
          expect(users[0].email).to.equal('mock-user@example.com');
          validatedSlackCall = true;
        },
      };

      const response = await controller.inviteUserToChannel(context);
      expect(response.status).to.equal(202);
      expect(validatedSlackCall).to.be.true;
    });
  });
});
