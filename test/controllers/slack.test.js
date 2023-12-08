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

import { expect } from 'chai';
import sinon from 'sinon';
import { Response } from '@adobe/fetch';

import SlackController from '../../src/controllers/slack.js';

describe('SlackController', () => {
  let testPayload;
  let mockSlackBot;
  let context;
  let logStub;

  beforeEach(() => {
    mockSlackBot = { processEvent: sinon.stub().resolves() };
    logStub = { info: sinon.stub(), error: sinon.stub() };
    testPayload = { type: 'event_callback', event: {} };
    context = {
      log: logStub,
      data: {},
      pathInfo: { headers: new Map() },
    };

    context.data = testPayload;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('handleEvent', () => {
    it('should respond to URL verification', async () => {
      context.data = { type: 'url_verification', challenge: 'challenge_token' };

      const controller = SlackController(mockSlackBot);
      const response = await controller.handleEvent(context);
      const json = await response.json();

      expect(response).to.be.an.instanceof(Response);
      expect(json).to.deep.equal({ challenge: 'challenge_token' });
    });

    it('ignores retry events due to http_timeout', async () => {
      context.pathInfo.headers.set('x-slack-retry-reason', 'http_timeout');
      context.data = { event_id: '123' };

      const controller = SlackController(mockSlackBot);
      const response = await controller.handleEvent(context);

      expect(logStub.info.calledWith('Ignoring retry event: 123')).to.be.true;
      expect(response).to.be.an.instanceof(Response);
      expect(response.headers.get('x-error')).to.equal('ignored-event');
    });

    it('processes normal Slack events correctly', async () => {
      mockSlackBot.processEvent.callsFake((event) => {
        expect(event.body).to.deep.equal(testPayload);
        expect(event.ack).to.be.a('function');
        event.ack();
      });

      const controller = SlackController(mockSlackBot);
      const response = await controller.handleEvent(context);

      expect(mockSlackBot.processEvent.calledOnce).to.be.true;
      expect(mockSlackBot.processEvent.firstCall.firstArg.body).to.deep.equal(testPayload);
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(200);
    });

    it('processes Slack events with data payload', async () => {
      context.data.payload = '{ "test": "payload" }';

      const controller = SlackController(mockSlackBot);
      const response = await controller.handleEvent(context);

      expect(mockSlackBot.processEvent.calledOnce).to.be.true;
      expect(mockSlackBot.processEvent.firstCall.firstArg.body).to.deep.equal({ test: 'payload' });
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(200);
    });

    it('handles errors during event processing', async () => {
      const testError = new Error('Test error');

      mockSlackBot.processEvent.rejects(testError);

      const controller = SlackController(mockSlackBot);
      const response = await controller.handleEvent(context);

      expect(mockSlackBot.processEvent.calledOnce).to.be.true;
      expect(mockSlackBot.processEvent.firstCall.firstArg.body).to.deep.equal(testPayload);
      expect(logStub.error.calledWith(`Error processing event: ${testError.message}`)).to.be.true;
      expect(response).to.be.an.instanceof(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal(testError.message);
    });
  });
});
