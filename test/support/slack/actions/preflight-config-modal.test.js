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
import esmock from 'esmock';
import {
  preflightConfigModal,
} from '../../../../src/support/slack/actions/preflight-config-modal.js';

use(chaiAsPromised);
use(sinonChai);

describe('preflight-config-modal', () => {
  let sandbox;
  let context;
  let siteMock;
  let configurationMock;
  let ackMock;
  let clientMock;
  let body;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    siteMock = {
      findById: sandbox.stub(),
      getBaseURL: sandbox.stub().returns('https://example.com'),
      setAuthoringType: sandbox.stub(),
      setDeliveryConfig: sandbox.stub(),
      setHlxConfig: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    configurationMock = {
      findLatest: sandbox.stub().resolves({
        enableHandlerForSite: sandbox.stub(),
        save: sandbox.stub().resolves(),
      }),
    };

    context = {
      dataAccess: {
        Site: siteMock,
        Configuration: configurationMock,
      },
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    ackMock = sandbox.stub().resolves();
    clientMock = {
      chat: {
        postMessage: sandbox.stub().resolves(),
      },
    };

    body = {
      view: {
        private_metadata: JSON.stringify({
          siteId: 'site123',
          auditType: 'preflight',
          channelId: 'C12345',
        }),
        state: {
          values: {
            authoring_type_input: {
              authoring_type: {
                selected_option: {
                  value: 'cs',
                },
              },
            },
            preview_url_input: {
              preview_url: {
                value: 'https://author-p12345-e67890.adobeaemcloud.com',
              },
            },
          },
        },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('preflightConfigModal', () => {
    it('should handle AEM CS preview URL for cs authoring type', async () => {
      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js', {
        '../../../../src/support/slack/actions/onboard-modal.js': {
          extractDeliveryConfigFromPreviewUrl: sinon.stub().returns({
            programId: '12345',
            environmentId: '67890',
            authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
          }),
        },
      });

      siteMock.findById.resolves(siteMock);

      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(siteMock.setAuthoringType).to.have.been.calledWith('cs');
      expect(siteMock.setDeliveryConfig).to.have.been.calledWith({
        programId: '12345',
        environmentId: '67890',
        authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
      });
      expect(siteMock.save).to.have.been.calledOnce;
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':white_check_mark: Successfully configured and enabled preflight audit for `https://example.com`\n:writing_hand: *Authoring Type:* cs\n:gear: *Delivery Config:* Program 12345, Environment 67890\n:link: *Preview URL:* https://author-p12345-e67890.adobeaemcloud.com',
        thread_ts: undefined,
      });
    });

    it('should handle helix preview URL for documentauthoring type', async () => {
      body.view.state.values.authoring_type_input.authoring_type.selected_option.value = 'documentauthoring';
      body.view.state.values.preview_url_input.preview_url.value = 'https://main--site--owner.hlx.live';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js', {
        '../../../../src/support/slack/actions/onboard-modal.js': {
          extractDeliveryConfigFromPreviewUrl: sinon.stub().returns(null),
        },
      });

      siteMock.findById.resolves(siteMock);

      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(siteMock.setAuthoringType).to.have.been.calledWith('documentauthoring');
      expect(siteMock.setHlxConfig).to.have.been.calledWith({
        hlxVersion: 5,
        rso: {
          ref: 'main',
          site: 'site',
          owner: 'owner',
          tld: 'hlx.live',
        },
      });
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':white_check_mark: Successfully configured and enabled preflight audit for `https://example.com`\n:writing_hand: *Authoring Type:* documentauthoring\n:gear: *Helix Config:* main--site--owner.hlx.live\n:link: *Preview URL:* https://main--site--owner.hlx.live',
        thread_ts: undefined,
      });
    });

    it('should handle helix preview URL for ams type', async () => {
      body.view.state.values.authoring_type_input.authoring_type.selected_option.value = 'ams';
      body.view.state.values.preview_url_input.preview_url.value = 'https://some-preview.url';

      siteMock.findById.resolves(siteMock);

      const modalAction = preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnce;
      expect(siteMock.setAuthoringType).to.have.been.calledWith('ams');
      expect(siteMock.setDeliveryConfig).to.have.been.calledWith({
        authorURL: 'https://some-preview.url',
      });
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':white_check_mark: Successfully configured and enabled preflight audit for `https://example.com`\n:writing_hand: *Authoring Type:* ams\n:gear: *Authoring URL:* https://some-preview.url',
        thread_ts: undefined,
      });
    });

    it('should validate required authoring type field', async () => {
      body.view.state.values.authoring_type_input.authoring_type.selected_option = null;

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js');
      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          authoring_type_input: 'Authoring type is required.',
        },
      });
    });

    it('should validate required preview URL field', async () => {
      body.view.state.values.preview_url_input.preview_url.value = '';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js');
      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          preview_url_input: 'Preview URL is required.',
        },
      });
    });

    it('should validate AEM CS URL format for cs authoring type', async () => {
      body.view.state.values.preview_url_input.preview_url.value = 'https://invalid-url.com';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js', {
        '../../../../src/support/slack/actions/onboard-modal.js': {
          extractDeliveryConfigFromPreviewUrl: sinon.stub().returns(null),
        },
      });

      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          preview_url_input: 'Could not extract program/environment ID from this URL. Please provide a valid AEM CS preview URL (e.g., https://author-p12345-e67890.adobeaemcloud.com).',
        },
      });
    });

    it('should validate helix URL format for documentauthoring type', async () => {
      body.view.state.values.authoring_type_input.authoring_type.selected_option.value = 'documentauthoring';
      body.view.state.values.preview_url_input.preview_url.value = 'https://invalid-helix-url.com';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js');
      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          preview_url_input: 'Could not extract RSO information from this URL. Please provide a valid Helix preview URL (e.g., https://main--site--owner.hlx.live).',
        },
      });
    });

    it('should handle unsupported authoring type', async () => {
      body.view.state.values.authoring_type_input.authoring_type.selected_option.value = 'unsupported';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js');
      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          authoring_type_input: 'Unsupported authoring type for preflight audit.',
        },
      });
    });

    it('should handle site not found error', async () => {
      siteMock.findById.resolves(null);

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js', {
        '../../../../src/support/slack/actions/onboard-modal.js': {
          extractDeliveryConfigFromPreviewUrl: sinon.stub().returns({
            programId: '12345',
            environmentId: '67890',
          }),
        },
      });

      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':x: Error: Site not found. Please try again.',
        thread_ts: undefined,
      });
    });

    it('should handle malformed private metadata', async () => {
      body.view.private_metadata = 'invalid-json{';

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js');
      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(context.log.warn).to.have.been.calledWith('Failed to parse private metadata:', sinon.match.instanceOf(Error));
    });

    it('should handle errors during processing', async () => {
      siteMock.findById.rejects(new Error('Database error'));

      const mockedModule = await esmock('../../../../src/support/slack/actions/preflight-config-modal.js', {
        '../../../../src/support/slack/actions/onboard-modal.js': {
          extractDeliveryConfigFromPreviewUrl: sinon.stub().returns({
            programId: '12345',
            environmentId: '67890',
          }),
        },
      });

      const modalAction = mockedModule.preflightConfigModal(context);
      await modalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(context.log.error).to.have.been.calledWith('Error handling preflight config modal:', sinon.match.instanceOf(Error));
      expect(ackMock).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          authoring_type_input: 'There was an error processing the configuration. Please try again.',
        },
      });
    });
  });
});
