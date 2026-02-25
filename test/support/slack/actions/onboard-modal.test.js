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
import * as sfn from '@aws-sdk/client-sfn';
import esmock from 'esmock';
import nock from 'nock';
import { isValidUrl } from '@adobe/spacecat-shared-utils';

use(chaiAsPromised);
use(sinonChai);

// Mock the onboard-modal module with network dependencies stubbed
let startOnboarding;
let onboardSiteModal;
let extractDeliveryConfigFromPreviewUrl;
let triggerBrandProfileAgentStub;

describe('onboard-modal', () => {
  let sandbox;

  before(async () => {
    // Mock the network-dependent modules before importing
    triggerBrandProfileAgentStub = sinon.stub().resolves('exec-123');

    const mockedModule = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
      '../../../../src/utils/slack/base.js': {
        loadProfileConfig: sinon.stub().resolves({
          audits: ['scrape-top-pages', 'broken-backlinks', 'broken-internal-links', 'experimentation-opportunities', 'meta-tags', 'sitemap', 'cwv', 'alt-text', 'broken-backlinks-auto-suggest', 'meta-tags-auto-suggest', 'broken-internal-links-auto-suggest'],
          imports: ['organic-traffic', 'top-pages', 'organic-keywords', 'all-traffic'],
          profile: 'demo',
        }),
      },
      '../../../../src/support/utils.js': {
        onboardSingleSite: sinon.stub().resolves({
          siteId: 'site123',
          projectId: 'project123',
          imsOrgId: '1234567894ABCDEF12345678@AdobeOrg',
          spacecatOrgId: 'org123',
          deliveryType: 'aem_edge',
          authoringType: 'documentauthoring',
          existingSite: 'No',
          profile: 'demo',
          audits: 'scrape-top-pages, broken-backlinks, broken-internal-links, experimentation-opportunities, meta-tags, sitemap, cwv, alt-text, broken-backlinks-auto-suggest, meta-tags-auto-suggest, broken-internal-links-auto-suggest',
          imports: 'organic-traffic, top-pages, organic-keywords, all-traffic',
          errors: [],
          tier: 'free_trial',
          language: 'en',
          region: 'US',
        }),
      },
      '../../../../src/support/brand-profile-trigger.js': {
        triggerBrandProfileAgent: (...args) => triggerBrandProfileAgentStub(...args),
      },
      '@adobe/spacecat-shared-utils': {
        isValidUrl,
        detectBotBlocker: sinon.stub().resolves({
          crawlable: true,
          type: 'none',
          confidence: 0,
        }),
      },
    });

    ({ startOnboarding, onboardSiteModal, extractDeliveryConfigFromPreviewUrl } = mockedModule);
  });

  beforeEach(() => {
    // Block all network requests
    nock.disableNetConnect();
    sandbox = sinon.createSandbox();
    triggerBrandProfileAgentStub.resetHistory();
  });

  afterEach(() => {
    // Clean up after each test
    nock.cleanAll();
    nock.enableNetConnect();
    sandbox.restore();
  });

  describe('extractDeliveryConfigFromPreviewUrl', () => {
    it('should validate valid AEM CS preview URLs', async () => {
      const previewUrl = 'https://author-p12345-e67890.adobeaemcloud.com';
      const imsOrgId = '908936ED5D35CC220A495CD4@AdobeOrg';
      const {
        programId,
        environmentId,
        authorURL,
        preferContentApi,
        imsOrgId: returnedImsOrgId,
      } = extractDeliveryConfigFromPreviewUrl(previewUrl, imsOrgId);
      expect(programId).to.equal('12345');
      expect(environmentId).to.equal('67890');
      expect(authorURL).to.equal('https://author-p12345-e67890.adobeaemcloud.com');
      expect(preferContentApi).to.equal(true);
      expect(returnedImsOrgId).to.equal(imsOrgId);
    });

    it('should validate valid AMS preview URLs', async () => {
      const previewURL = 'https://author.adobecqms.net';

      const {
        authorURL,
        preferContentApi,
        imsOrgId,
      } = extractDeliveryConfigFromPreviewUrl(previewURL);
      expect(authorURL).to.equal('https://author.adobecqms.net');
      expect(preferContentApi).to.equal(true);
      expect(imsOrgId).to.equal(null);
    });

    it('should return null for non-http/https URLs', async () => {
      expect(extractDeliveryConfigFromPreviewUrl('ftp://example.com', null)).to.be.null;
      expect(extractDeliveryConfigFromPreviewUrl('file:///path/to/file', null)).to.be.null;
    });

    it('should return null for malformed URLs', async () => {
      expect(extractDeliveryConfigFromPreviewUrl('not-a-valid-url', null)).to.be.null;
      expect(extractDeliveryConfigFromPreviewUrl('', null)).to.be.null;
      expect(extractDeliveryConfigFromPreviewUrl(null, null)).to.be.null;
      expect(extractDeliveryConfigFromPreviewUrl(undefined, null)).to.be.null;
    });

    it('should handle null imsOrgId gracefully', async () => {
      const previewUrl = 'https://author-p12345-e67890.adobeaemcloud.com';
      const result = extractDeliveryConfigFromPreviewUrl(previewUrl, null);
      expect(result.imsOrgId).to.be.null;
      expect(result.preferContentApi).to.equal(true);
    });
  });

  describe('startOnboarding', () => {
    let context;
    let ackMock;
    let respondMock;
    let clientMock;
    let body;

    beforeEach(() => {
      ackMock = sandbox.stub().resolves();
      respondMock = sandbox.stub().resolves();
      clientMock = {
        views: {
          open: sandbox.stub().resolves(),
        },
      };

      context = {
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
          debug: sandbox.stub(),
        },
      };

      body = {
        user: {
          name: 'test-user',
          id: 'U12345',
        },
        channel: {
          id: 'C12345',
        },
        message: {
          ts: '1234567890.123456',
          thread_ts: '1234567890.123456',
        },
        trigger_id: 'trigger123',
        actions: [
          {
            value: 'start_onboarding',
          },
        ],
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should open modal with no initial values for basic onboarding', async () => {
      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      expect(ackMock).to.have.been.called;
      expect(respondMock).to.have.been.calledOnceWith({
        text: ':gear: test-user started the onboarding process...',
        replace_original: true,
      });

      expect(clientMock.views.open).to.have.been.calledOnce;
      const openCall = clientMock.views.open.firstCall.args[0];
      expect(openCall.trigger_id).to.equal('trigger123');
      expect(openCall.view.callback_id).to.equal('onboard_site_modal');

      const metadata = JSON.parse(openCall.view.private_metadata);
      expect(metadata.originalChannel).to.equal('C12345');
      expect(metadata.originalThreadTs).to.equal('1234567890.123456');
    });

    it('should parse and pre-populate initial values from button value', async () => {
      const initialValues = {
        site: 'https://example.com',
        imsOrgId: 'ABC123@AdobeOrg',
        profile: 'demo',
        workflowWaitTime: '300',
        projectId: 'project123',
        language: 'fr',
        region: 'CH',
      };

      body.actions[0].value = JSON.stringify(initialValues);

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      expect(clientMock.views.open).to.have.been.calledOnce;
      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;

      // Check that site URL is pre-populated
      const siteUrlBlock = blocks.find((block) => block.block_id === 'site_url_input');
      expect(siteUrlBlock.element.initial_value).to.equal('https://example.com');

      // Check that IMS Org ID is pre-populated
      const imsOrgBlock = blocks.find((block) => block.block_id === 'ims_org_input');
      expect(imsOrgBlock.element.initial_value).to.equal('ABC123@AdobeOrg');

      // Check that wait time is pre-populated
      const waitTimeBlock = blocks.find((block) => block.block_id === 'wait_time_input');
      expect(waitTimeBlock.element.initial_value).to.equal('300');

      // Check that project ID is pre-populated
      const projectIdBlock = blocks.find((block) => block.block_id === 'project_id_input');
      expect(projectIdBlock.element.initial_value).to.equal('project123');

      // Check that language is pre-populated
      const languageBlock = blocks.find((block) => block.block_id === 'language_input');
      expect(languageBlock.element.initial_value).to.equal('fr');

      // Check that region is pre-populated
      const regionBlock = blocks.find((block) => block.block_id === 'region_input');
      expect(regionBlock.element.initial_value).to.equal('CH');
    });

    it('should handle invalid JSON in button value gracefully', async () => {
      body.actions[0].value = 'invalid-json{';

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      expect(context.log.warn).to.have.been.calledWith('Failed to parse initial values from button:', sinon.match.instanceOf(Error));
      expect(clientMock.views.open).to.have.been.calledOnce;
    });

    it('should handle missing channel and message context', async () => {
      delete body.channel;
      delete body.message;

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      const openCall = clientMock.views.open.firstCall.args[0];
      const metadata = JSON.parse(openCall.view.private_metadata);
      expect(metadata.originalChannel).to.be.undefined;
      expect(metadata.originalThreadTs).to.be.undefined;
    });

    it('should handle thread_ts when message.thread_ts is not available', async () => {
      delete body.message.thread_ts;

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      const openCall = clientMock.views.open.firstCall.args[0];
      const metadata = JSON.parse(openCall.view.private_metadata);
      expect(metadata.originalThreadTs).to.equal('1234567890.123456'); // falls back to message.ts
    });

    it('should handle errors during modal opening', async () => {
      clientMock.views.open.rejects(new Error('Slack API error'));

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      expect(context.log.error).to.have.been.calledWith('Error handling start onboarding:', sinon.match.instanceOf(Error));
      expect(respondMock).to.have.been.calledWith({
        text: ':x: There was an error starting the onboarding process.',
        replace_original: false,
      });
    });

    it('should set correct profile initial option based on provided value', async () => {
      const initialValues = { profile: 'paid' };
      body.actions[0].value = JSON.stringify(initialValues);

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;
      const profileBlock = blocks.find((block) => block.block_id === 'profile_input');

      expect(profileBlock.element.initial_option.value).to.equal('paid');
      expect(profileBlock.element.initial_option.text.text).to.equal('Paid');
    });

    it('should handle unknown profile value gracefully', async () => {
      const initialValues = { profile: 'unknown-profile' };
      body.actions[0].value = JSON.stringify(initialValues);

      const startOnboardingAction = startOnboarding(context);

      await startOnboardingAction({
        ack: ackMock,
        body,
        client: clientMock,
        respond: respondMock,
      });

      const openCall = clientMock.views.open.firstCall.args[0];
      const { blocks } = openCall.view;
      const profileBlock = blocks.find((block) => block.block_id === 'profile_input');

      // Should default to 'demo' for unknown profiles
      expect(profileBlock.element.initial_option.value).to.equal('demo');
      expect(profileBlock.element.initial_option.text.text).to.equal('Demo');
    });
  });

  describe('onboardSiteModal', () => {
    let context;
    let ackMock;
    let clientMock;
    let body;
    let siteMock;
    let configurationMock;
    let organizationMock;
    let configMock;
    let entitlementMock;
    let siteEnrollmentMock;

    beforeEach(() => {
      ackMock = sandbox.stub().resolves();
      clientMock = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      configMock = {
        enableImport: sandbox.stub().resolves({}),
        getSlackConfig: sandbox.stub().resolves({}),
        getHandlers: sandbox.stub().returns([]),
        getContentAiConfig: sandbox.stub().resolves({}),
        getImports: sandbox.stub().returns([]),
        getFetchConfig: sandbox.stub().resolves({}),
        getBrandConfig: sandbox.stub().resolves({}),
        getCdnLogsConfig: sandbox.stub().resolves({}),
        getLlmoConfig: sandbox.stub().resolves({}),
      };

      siteMock = {
        findById: sandbox.stub(),
        getDeliveryConfig: sandbox.stub().returns({}),
        setDeliveryConfig: sandbox.stub(),
        setAuthoringType: sandbox.stub(),
        save: sandbox.stub().resolves(),
        findByBaseURL: sandbox.stub().resolves({
          getId: sandbox.stub().returns('site123'),
          getDeliveryType: sandbox.stub().returns('aem_edge'),
          getOrganizationId: sandbox.stub().returns('org123'),
          getConfig: sandbox.stub().returns(configMock),
          setConfig: sandbox.stub().resolves({}),
          save: sandbox.stub().resolves(),
        }),
      };

      configurationMock = {
        findLatest: sandbox.stub().resolves({ save: sandbox.stub().resolves() }),
        getQueues: sandbox.stub().resolves({}),
        enableHandlerForSite: sandbox.stub().resolves({}),
        isHandlerEnabledForSite: sandbox.stub().returns(false),
        save: sandbox.stub().resolves(),
      };

      organizationMock = {
        findByImsOrgId: sandbox.stub().resolves({
          getId: sandbox.stub().returns('org123'),
        }),
      };

      entitlementMock = {
      };

      siteEnrollmentMock = {
      };

      context = {
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        sqs: {
          sendMessage: sandbox.stub().resolves(),
        },
        dataAccess: {
          Site: siteMock,
          Configuration: configurationMock,
          Organization: organizationMock,
          Entitlement: entitlementMock,
          SiteEnrollment: siteEnrollmentMock,
        },
        env: {
          AWS_REGION: 'us-east-1',
          DEMO_IMS_ORG: '1234567894ABCDEF12345678@AdobeOrg',
          WORKFLOW_WAIT_TIME_IN_SECONDS: 300,
          ONBOARD_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123456789012:stateMachine:onboard-workflow',
        },
        imsClient: {
          getOrganization: sandbox.stub().resolves({
            orgId: 'org123',
            name: 'Test Organization',
          }),
        },
      };

      body = {
        user: {
          name: 'test-user',
          id: 'U12345',
        },
        view: {
          state: {
            values: {
              site_url_input: {
                site_url: {
                  value: 'https://example.com',
                },
              },
              ims_org_input: {
                ims_org_id: {
                  value: '',
                },
              },
              project_id_input: {
                project_id: {
                  value: 'project123',
                },
              },
              profile_input: {
                profile: {
                  selected_option: {
                    value: 'demo',
                  },
                },
              },
              delivery_type_input: {
                delivery_type: {
                  selected_option: {
                    value: 'aem_edge',
                  },
                },
              },
              authoring_type_input: {
                authoring_type: {
                  selected_option: {
                    value: 'documentauthoring',
                  },
                },
              },
              tier_input: {
                tier: {
                  selected_option: {
                    value: 'paid',
                  },
                },
              },
              wait_time_input: {
                wait_time: {
                  value: '30',
                },
              },
              preview_url_input: {
                preview_url: {
                  value: '',
                },
              },
              scheduled_run_input: {
                scheduled_run: {
                  selected_option: {
                    value: 'false',
                  },
                },
              },
              language_input: {
                language: {
                  value: 'en',
                },
              },
              region_input: {
                region: {
                  value: 'us',
                },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'C12345',
            originalThreadTs: '1234567890.123456',
          }),
        },
      };

      sandbox.stub(sfn.SFNClient.prototype, 'send').resolves({ executionArn: 'arn:xyz' });
    });

    it('should validate required site URL', async () => {
      body.view.state.values.site_url_input.site_url.value = '';

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnceWith({
        response_action: 'errors',
        errors: {
          site_url_input: 'Please provide a site URL',
        },
      });
    });

    it('should validate preview URL format when provided', async () => {
      body.view.state.values.preview_url_input.preview_url.value = 'invalid-preview-url';

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnceWith({
        response_action: 'errors',
        errors: {
          preview_url_input: 'Please provide a valid preview URL.',
        },
      });
    });

    it('should require authoring type when preview URL is provided', async () => {
      body.view.state.values.preview_url_input.preview_url.value = 'https://author-p12345-e67890.adobeaemcloud.com';
      body.view.state.values.authoring_type_input.authoring_type.selected_option = null;

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledOnceWith({
        response_action: 'errors',
        errors: {
          authoring_type_input: 'Authoring type is required when a preview URL is provided.',
        },
      });
    });

    it('should successfully process valid modal submission with original thread context', async () => {
      body.view.state.values.preview_url_input.preview_url.value = 'https://author-p12345-e67890.adobeaemcloud.com';
      const deliveryConfig = {
        programId: '12345',
        environmentId: '67890',
        authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
      };
      const deliveryTypeConfigMock = sandbox.stub();
      siteMock.findById.resolves({
        getDeliveryConfig: sandbox.stub().returns({
          programId: deliveryConfig.programId,
          environmentId: deliveryConfig.environmentId,
        }),
        setDeliveryConfig: deliveryTypeConfigMock,
        setAuthoringType: sandbox.stub(),
        save: sandbox.stub().resolves(),
      });
      const onboardSiteModalAction = onboardSiteModal(context);

      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.calledTwice;

      // Note: delivery config is now set during site creation, not afterward
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':gear: Starting onboarding for site https://example.com...',
        thread_ts: '1234567890.123456',
      });

      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':white_check_mark: *Onboarding triggered successfully by test-user!*\n'
          + '\n'
          + ':ims: *IMS Org ID:* 1234567894ABCDEF12345678@AdobeOrg\n'
          + ':groups: *Project ID:* project123\n'
          + ':space-cat: *Spacecat Org ID:* org123\n'
          + ':identification_card: *Site ID:* site123\n'
          + ':cat-egory-white: *Delivery Type:* aem_edge\n'
          + ':writing_hand: *Authoring Type:* documentauthoring\n'
          + ':gear: *Delivery Config:* Program 12345, Environment 67890\n'
          + ':globe_with_meridians: *Preview Environment:* Configured with Program 12345, Environment 67890\n'
          + ':paid: *Entitlement Tier:* free_trial\n'
          + ':speaking_head_in_silhouette: *Language Code:* en\n'
          + ':globe_with_meridians: *Country Code:* US\n'
          + ':question: *Already existing:* No\n'
          + ':gear: *Profile:* demo\n'
          + ':hourglass_flowing_sand: *Wait Time:* 30 seconds\n'
          + ':clipboard: *Audits:* scrape-top-pages, broken-backlinks, broken-internal-links, experimentation-opportunities, meta-tags, sitemap, cwv, alt-text, broken-backlinks-auto-suggest, meta-tags-auto-suggest, broken-internal-links-auto-suggest\n'
          + ':inbox_tray: *Imports:* organic-traffic, top-pages, organic-keywords, all-traffic\n'
          + '        ',
        thread_ts: '1234567890.123456',
      });

      expect(triggerBrandProfileAgentStub).to.have.been.calledOnce;
      expect(triggerBrandProfileAgentStub.firstCall.args[0]).to.include({
        reason: 'aso-slack',
      });
    });

    it('should handle malformed private metadata gracefully', async () => {
      body.view.private_metadata = 'invalid-json{';
      context.dataAccess.Site = {
        findByBaseURL: sandbox.stub().resolves({
          getId: sandbox.stub().returns(null),
          getDeliveryType: sandbox.stub().returns('aem_edge'),
          getOrganizationId: sandbox.stub().returns('123'),
          getConfig: sandbox.stub().returns(configMock),
          setConfig: sandbox.stub().resolves({}),
          save: sandbox.stub().resolves({}),
        }),
        save: sandbox.stub().resolves({}),
      };
      const onboardSiteModalAction = onboardSiteModal(context);
      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(context.log.warn).to.have.been.calledWith('Failed to parse private metadata:', sinon.match.instanceOf(Error));

      expect(clientMock.chat.postMessage).to.have.been.calledWith(
        sinon.match({
          channel: 'U12345',
        }),
      );
    });

    it('should handle empty private metadata, selected profile and wait time', async () => {
      body.view.private_metadata = null;
      body.view.state.values.profile_input.profile.selected_option.value = null;
      body.view.state.values.wait_time_input.wait_time.value = null;

      const onboardSiteModalAction = onboardSiteModal(context);
      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;

      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'U12345',
        text: ':gear: Starting onboarding for site https://example.com...',
        thread_ts: undefined,
      });
    });

    it('should handle delivery type with value "auto" and deliveryType default', async () => {
      body.view.state.values.delivery_type_input.delivery_type.selected_option = {
        value: 'auto',
      };
      body.view.state.values.authoring_type_input.authoring_type.selected_option = {
        value: 'default',
      };

      const onboardSiteModalAction = onboardSiteModal(context);
      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
    });

    it('should post a warning message onboarding fails', async () => {
      organizationMock.findByImsOrgId.resolves(null);
      context.imsClient = {
        getImsOrganizationDetails: sandbox.stub().rejects('Organization details error'),
      };
      const onboardSiteModalAction = onboardSiteModal(context);
      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':white_check_mark: *Onboarding triggered successfully by test-user!*\n'
          + '\n'
          + ':ims: *IMS Org ID:* 1234567894ABCDEF12345678@AdobeOrg\n'
          + ':groups: *Project ID:* project123\n'
          + ':space-cat: *Spacecat Org ID:* org123\n'
          + ':identification_card: *Site ID:* site123\n'
          + ':cat-egory-white: *Delivery Type:* aem_edge\n'
          + ':writing_hand: *Authoring Type:* documentauthoring\n'
          + '\n'
          + ':paid: *Entitlement Tier:* free_trial\n'
          + ':speaking_head_in_silhouette: *Language Code:* en\n'
          + ':globe_with_meridians: *Country Code:* US\n'
          + ':question: *Already existing:* No\n'
          + ':gear: *Profile:* demo\n'
          + ':hourglass_flowing_sand: *Wait Time:* 30 seconds\n'
          + ':clipboard: *Audits:* scrape-top-pages, broken-backlinks, broken-internal-links, experimentation-opportunities, meta-tags, sitemap, cwv, alt-text, broken-backlinks-auto-suggest, meta-tags-auto-suggest, broken-internal-links-auto-suggest\n'
          + ':inbox_tray: *Imports:* organic-traffic, top-pages, organic-keywords, all-traffic\n'
          + '        ',
        thread_ts: '1234567890.123456',
      });
    });

    it('responds with error when the onboarding request fails', async () => {
      const bodyWithError = JSON.parse(JSON.stringify(body));
      delete bodyWithError.view.state.values.site_url_input;
      const onboardSiteModalAction = onboardSiteModal(context);
      await onboardSiteModalAction({
        ack: ackMock,
        body: bodyWithError,
        client: clientMock,
      });
      expect(ackMock).to.have.been.calledOnceWith({
        response_action: 'errors',
        errors: {
          site_url_input: 'There was an error processing the onboarding request.',
        },
      });
      expect(clientMock.chat.postMessage).to.not.have.been.called;
    });

    it('should post error message when onboarding returns errors', async () => {
      const mockedModuleWithErrors = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: sinon.stub().resolves({
            audits: ['scrape-top-pages'],
            imports: ['organic-traffic'],
            profile: 'demo',
          }),
        },
        '../../../../src/support/utils.js': {
          onboardSingleSite: sinon.stub().resolves({
            siteId: 'site123',
            errors: ['Error during site creation', 'Configuration failed'],
          }),
        },
      });

      const { onboardSiteModal: onboardSiteModalWithErrors } = mockedModuleWithErrors;
      const onboardSiteModalAction = onboardSiteModalWithErrors(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: ':warning: Error during site creation,Configuration failed',
        thread_ts: '1234567890.123456',
      });
    });

    it('should handle errors when slackContext.say is called during onboarding process', async () => {
      const mockedModuleWithSayUsage = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: sinon.stub().resolves({
            audits: ['scrape-top-pages'],
            imports: ['organic-traffic'],
            profile: 'demo',
          }),
        },
        '../../../../src/support/utils.js': {
          onboardSingleSite: sinon.stub().callsFake(
            async (url, imsOrgId, config, profile, waitTime, slackContext) => {
              await slackContext.say('Test error message from onboarding process');
              return {
                siteId: 'site123',
                errors: [],
              };
            },
          ),
        },
      });

      const { onboardSiteModal: onboardSiteModalWithSayUsage } = mockedModuleWithSayUsage;
      const onboardSiteModalAction = onboardSiteModalWithSayUsage(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
      expect(clientMock.chat.postMessage).to.have.been.calledWith({
        channel: 'C12345',
        text: 'Test error message from onboarding process',
        thread_ts: '1234567890.123456',
      });
    });

    it('should handle case where site has no delivery config (getDeliveryConfig returns null)', async () => {
      body.view.state.values.preview_url_input.preview_url.value = 'https://author-p12345-e67890.adobeaemcloud.com';

      siteMock.findById.resolves({
        getDeliveryConfig: sandbox.stub().returns(null), // Test || {} fallback
        setDeliveryConfig: sandbox.stub(),
        setAuthoringType: sandbox.stub(),
        save: sandbox.stub().resolves(),
      });

      const onboardSiteModalAction = onboardSiteModal(context);
      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
      expect(siteMock.findById).to.have.been.calledWith('site123');
    });

    it('should handle case where reportLine has no siteId', async () => {
      const mockedModuleNoSiteId = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: sinon.stub().resolves({
            audits: ['scrape-top-pages'],
            imports: ['organic-traffic'],
            profile: 'demo',
          }),
        },
        '../../../../src/support/utils.js': {
          onboardSingleSite: sinon.stub().resolves({
            siteId: null, // No siteId returned
            errors: [],
          }),
        },
      });

      const { onboardSiteModal: onboardSiteModalNoSiteId } = mockedModuleNoSiteId;
      const onboardSiteModalAction = onboardSiteModalNoSiteId(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
      expect(clientMock.chat.postMessage).to.have.been.calledWith(
        sinon.match({
          text: sinon.match(':identification_card: *Site ID:* n/a'),
        }),
      );
    });

    it('should handle case where site has empty delivery config', async () => {
      const mockedModuleEmptyDelivery = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: sinon.stub().resolves({
            audits: ['scrape-top-pages'],
            imports: ['organic-traffic'],
            profile: 'demo',
          }),
        },
        '../../../../src/support/utils.js': {
          onboardSingleSite: sinon.stub().resolves({
            siteId: 'site123',
            errors: [],
          }),
        },
      });

      const { onboardSiteModal: onboardSiteModalEmptyDelivery } = mockedModuleEmptyDelivery;
      const siteWithNoDeliveryInfo = {
        getDeliveryConfig: sandbox.stub().returns({}), // Empty delivery config
      };

      const contextWithEmptyDelivery = {
        ...context,
        dataAccess: {
          ...context.dataAccess,
          Site: {
            findById: sandbox.stub().resolves(siteWithNoDeliveryInfo),
          },
        },
      };

      const onboardSiteModalAction = onboardSiteModalEmptyDelivery(contextWithEmptyDelivery);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
      const postMessageCalls = clientMock.chat.postMessage.getCalls();
      const messages = postMessageCalls.map((call) => call.args[0].text);
      const hasDeliveryConfigInfo = messages.some((text) => text.includes(':gear: *Delivery Config:*'));
      expect(hasDeliveryConfigInfo).to.be.false;
    });

    it('should handle delivery config with only programId', async () => {
      const mockedModulePartialDelivery = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: sinon.stub().resolves({
            audits: ['scrape-top-pages'],
            imports: ['organic-traffic'],
            profile: 'demo',
          }),
        },
        '../../../../src/support/utils.js': {
          onboardSingleSite: sinon.stub().resolves({
            siteId: 'site123',
            errors: [],
          }),
        },
      });

      const { onboardSiteModal: onboardSiteModalPartialDelivery } = mockedModulePartialDelivery;
      const siteWithPartialDelivery = {
        getDeliveryConfig: sandbox.stub().returns({
          programId: '12345',
        }),
      };

      const contextWithPartialDelivery = {
        ...context,
        dataAccess: {
          ...context.dataAccess,
          Site: {
            findById: sandbox.stub().resolves(siteWithPartialDelivery),
          },
        },
      };

      const onboardSiteModalAction = onboardSiteModalPartialDelivery(contextWithPartialDelivery);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;

      const postMessageCalls = clientMock.chat.postMessage.getCalls();
      const successMessages = postMessageCalls.filter((call) => call.args[0].text.includes(':white_check_mark: *Onboarding triggered successfully'));
      expect(successMessages.length).to.be.greaterThan(0);

      const hasDeliveryConfigWithProgramId = successMessages.some((call) => call.args[0].text.includes(':gear: *Delivery Config:* Program 12345'));
      expect(hasDeliveryConfigWithProgramId).to.be.true;
    });

    it('should fallback tier to free trial if not provided', async () => {
      body.view.state.values.tier_input.tier.selected_option = {
        value: undefined,
      };

      const onboardSiteModalAction = onboardSiteModal(context);
      configurationMock.findLatest.resolves(configurationMock);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;

      const postMessageCalls = clientMock.chat.postMessage.getCalls();
      const successMessages = postMessageCalls.filter((call) => call.args[0].text.includes(':white_check_mark: *Onboarding triggered successfully'));
      expect(successMessages.length).to.be.greaterThan(0);

      const hasTierInput = successMessages.some((call) => call.args[0].text.includes(':paid: *Entitlement Tier:* free_trial'));
      expect(hasTierInput).to.be.true;
    });

    it('should pass scheduledRun as true when selected in form', async () => {
      body.view.state.values.scheduled_run_input.scheduled_run.selected_option.value = 'true';

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;

      // Verify that the form value is properly extracted and passed
      // The actual verification would be in the onboardSingleSite function call
    });

    it('should pass scheduledRun as false when selected in form', async () => {
      body.view.state.values.scheduled_run_input.scheduled_run.selected_option.value = 'false';

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
    });

    it('should not pass scheduledRun when not selected in form', async () => {
      // Remove the scheduled_run_input from the form values
      delete body.view.state.values.scheduled_run_input;

      const onboardSiteModalAction = onboardSiteModal(context);

      await onboardSiteModalAction({
        ack: ackMock,
        body,
        client: clientMock,
      });

      expect(ackMock).to.have.been.called;
    });

    describe('Bot Protection Detection', () => {
      it('should warn about bot protection but continue onboarding', async () => {
        // Create a custom mock module for this test
        const testModule = await esmock('../../../../src/support/slack/actions/onboard-modal.js', {
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: sinon.stub().resolves({
              audits: ['scrape-top-pages'],
              imports: ['organic-traffic'],
              profile: 'demo',
            }),
          },
          '../../../../src/support/utils.js': {
            onboardSingleSite: sinon.stub().resolves({
              siteId: 'site123',
              errors: [],
            }),
          },
          '../../../../src/support/brand-profile-trigger.js': {
            triggerBrandProfileAgent: sinon.stub().resolves('exec-123'),
          },
          '@adobe/spacecat-shared-utils': {
            isValidUrl: () => true,
            detectBotBlocker: sinon.stub().resolves({
              crawlable: false,
              type: 'cloudflare',
              confidence: 0.95,
              reason: 'Bot protection detected',
            }),
          },
        });

        const modalAction = testModule.onboardSiteModal(context);

        await modalAction({
          ack: ackMock,
          body,
          client: clientMock,
        });

        const calls = clientMock.chat.postMessage.getCalls();
        const warningMessage = calls.find((call) => call.args[0].text?.includes('Bot Protection Detected'));
        expect(warningMessage).to.exist;

        const successMessage = calls.find((call) => call.args[0].text?.includes('Onboarding triggered successfully'));
        expect(successMessage).to.exist;
      });
    });
  });
});
