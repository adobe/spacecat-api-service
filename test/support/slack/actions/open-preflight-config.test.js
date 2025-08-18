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
/* eslint-env mocha */
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import openPreflightConfig from '../../../../src/support/slack/actions/open-preflight-config.js';

use(chaiAsPromised);
use(sinonChai);

describe('open-preflight-config', () => {
  let sandbox;
  let context;
  let siteMock;
  let ackMock;
  let clientMock;
  let body;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    siteMock = {
      findById: sandbox.stub(),
      getId: sandbox.stub().returns('site123'),
      getBaseURL: sandbox.stub().returns('https://example.com'),
      getAuthoringType: sandbox.stub().returns('cs'),
      getDeliveryConfig: sandbox.stub().returns({
        programId: '12345',
        environmentId: '67890',
        authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
      }),
    };

    context = {
      dataAccess: {
        Site: siteMock,
      },
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    ackMock = sandbox.stub().resolves();
    clientMock = {
      views: {
        open: sandbox.stub().resolves(),
      },
    };

    body = {
      actions: [{
        value: JSON.stringify({
          siteId: 'site123',
          auditType: 'preflight',
        }),
      }],
      trigger_id: 'trigger123',
      channel: {
        id: 'C12345',
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('openPreflightConfig', () => {
    it('should open modal with current site configuration for cs authoring type', async () => {
      siteMock.findById.resolves(siteMock);

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(siteMock.findById).to.have.been.calledWith('site123');
      expect(clientMock.views.open).to.have.been.calledOnce;

      const openCall = clientMock.views.open.firstCall.args[0];
      expect(openCall.trigger_id).to.equal('trigger123');
      expect(openCall.view.callback_id).to.equal('preflight_config_modal');

      const metadata = JSON.parse(openCall.view.private_metadata);
      expect(metadata.siteId).to.equal('site123');
      expect(metadata.auditType).to.equal('preflight');
      expect(metadata.channelId).to.equal('C12345');

      // Check that authoring type is pre-populated
      const { blocks } = openCall.view;
      const authoringBlock = blocks.find((block) => block.block_id === 'authoring_type_input');
      expect(authoringBlock.element.initial_option.value).to.equal('cs');
      expect(authoringBlock.element.initial_option.text.text).to.equal('Cloud Service');

      // Check that preview URL is pre-populated
      const urlBlock = blocks.find((block) => block.block_id === 'preview_url_input');
      expect(urlBlock.element.initial_value).to.equal('https://author-p12345-e67890.adobeaemcloud.com');
    });

    it('should open modal with documentauthoring authoring type', async () => {
      siteMock.getAuthoringType.returns('documentauthoring');
      siteMock.getDeliveryConfig.returns({});
      siteMock.findById.resolves(siteMock);

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(clientMock.views.open).to.have.been.calledOnce;
      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;

      const authoringBlock = blocks.find((block) => block.block_id === 'authoring_type_input');
      expect(authoringBlock.element.initial_option.value).to.equal('documentauthoring');
      expect(authoringBlock.element.initial_option.text.text).to.equal('Document Authoring');
    });

    it('should open modal with cs/crosswalk authoring type', async () => {
      siteMock.getAuthoringType.returns('cs/crosswalk');
      siteMock.findById.resolves(siteMock);

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(clientMock.views.open).to.have.been.calledOnce;
      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;

      const authoringBlock = blocks.find((block) => block.block_id === 'authoring_type_input');
      expect(authoringBlock.element.initial_option.value).to.equal('cs/crosswalk');
      expect(authoringBlock.element.initial_option.text.text).to.equal('Cloud Service/Crosswalk');
    });

    it('should handle empty authoring type', async () => {
      siteMock.getAuthoringType.returns(null);
      siteMock.getDeliveryConfig.returns(null);
      siteMock.findById.resolves(siteMock);

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(clientMock.views.open).to.have.been.calledOnce;
      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;

      const authoringBlock = blocks.find((block) => block.block_id === 'authoring_type_input');
      expect(authoringBlock.element.initial_option).to.be.undefined;
    });

    it('should handle site not found', async () => {
      siteMock.findById.resolves(null);

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(context.log.error).to.have.been.calledWith('Site with ID site123 not found');
    });

    it('should handle invalid JSON in button value', async () => {
      body.actions[0].value = 'invalid-json{';

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(context.log.error).to.have.been.calledWith('Error opening preflight config modal:', sinon.match.instanceOf(Error));
    });

    it('should handle modal opening error', async () => {
      siteMock.findById.resolves(siteMock);
      clientMock.views.open.rejects(new Error('Modal error'));

      const openAction = openPreflightConfig(context);
      await openAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(context.log.error).to.have.been.calledWith('Error opening preflight config modal:', sinon.match.instanceOf(Error));
    });
  });
});
