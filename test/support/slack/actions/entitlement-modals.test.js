/*
 * Copyright 2024 Adobe. All rights reserved.
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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('EntitlementModals', () => {
  let openEnsureEntitlementSiteModal;
  let openEnsureEntitlementImsOrgModal;
  let openRevokeEntitlementSiteModal;
  let openRevokeEntitlementImsOrgModal;
  let ensureEntitlementSiteModal;
  let ensureEntitlementImsOrgModal;
  let revokeEntitlementSiteModal;
  let revokeEntitlementImsOrgModal;
  let lambdaContext;
  let mockCreateEntitlementsForProducts;
  let mockPostEntitlementMessages;
  let mockUpdateMessageToProcessing;

  before(async () => {
    mockCreateEntitlementsForProducts = sinon.stub().resolves([
      { product: 'ASO', entitlementId: 'ent-1', enrollmentId: 'enr-1' },
    ]);
    mockPostEntitlementMessages = sinon.stub().resolves();
    mockUpdateMessageToProcessing = sinon.stub().resolves();

    const module = await esmock('../../../../src/support/slack/actions/entitlement-modals.js', {
      '../../../../src/support/slack/actions/entitlement-modal-utils.js': {
        createProductSelectionModal: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
          .then((m) => m.createProductSelectionModal),
        extractSelectedProducts: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
          .then((m) => m.extractSelectedProducts),
        createSayFunction: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
          .then((m) => m.createSayFunction),
        createEntitlementsForProducts: mockCreateEntitlementsForProducts,
        postEntitlementMessages: mockPostEntitlementMessages,
        updateMessageToProcessing: mockUpdateMessageToProcessing,
      },
      '@adobe/spacecat-shared-tier-client': {
        default: {
          createForSite: sinon.stub().resolves({
            revokeSiteEnrollment: sinon.stub().resolves(),
          }),
          createForOrg: sinon.stub().returns({
            createEntitlement: sinon.stub().resolves({
              entitlement: { getId: () => 'ent-123' },
            }),
            revokeEntitlement: sinon.stub().resolves(),
          }),
        },
      },
    });

    openEnsureEntitlementSiteModal = module.openEnsureEntitlementSiteModal;
    openEnsureEntitlementImsOrgModal = module.openEnsureEntitlementImsOrgModal;
    openRevokeEntitlementSiteModal = module.openRevokeEntitlementSiteModal;
    openRevokeEntitlementImsOrgModal = module.openRevokeEntitlementImsOrgModal;
    ensureEntitlementSiteModal = module.ensureEntitlementSiteModal;
    ensureEntitlementImsOrgModal = module.ensureEntitlementImsOrgModal;
    revokeEntitlementSiteModal = module.revokeEntitlementSiteModal;
    revokeEntitlementImsOrgModal = module.revokeEntitlementImsOrgModal;
  });

  beforeEach(() => {
    lambdaContext = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
      },
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves({
            getId: () => 'site-123',
            getBaseURL: () => 'https://example.com',
          }),
        },
        Organization: {
          findById: sinon.stub().resolves({
            getId: () => 'org-123',
            getName: () => 'Test Org',
          }),
        },
        SiteEnrollment: {
          allByEntitlementId: sinon.stub().resolves([]),
        },
      },
    };

    mockCreateEntitlementsForProducts.resetHistory();
    mockPostEntitlementMessages.resetHistory();
    mockUpdateMessageToProcessing.resetHistory();
  });

  describe('openEnsureEntitlementSiteModal', () => {
    it('opens modal with correct metadata', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: { open: sinon.stub().resolves() },
      };
      const body = {
        actions: [{
          value: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
        }],
        trigger_id: 'trigger-123',
      };

      const handler = openEnsureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(client.views.open).to.have.been.calledOnce;
    });

    it('handles errors when opening modal', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: { open: sinon.stub().rejects(new Error('Modal error')) },
      };
      const body = {
        actions: [{ value: JSON.stringify({ siteId: 'site-123', baseURL: 'https://example.com' }) }],
        trigger_id: 'trigger-123',
      };

      const handler = openEnsureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });

  describe('ensureEntitlementSiteModal', () => {
    it('processes modal submission successfully', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
      expect(mockCreateEntitlementsForProducts).to.have.been.calledOnce;
    });

    it('handles errors during entitlement creation', async () => {
      mockCreateEntitlementsForProducts.rejects(new Error('Creation failed'));
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles no products selected', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
        text: sinon.match(':warning:'),
      }));
    });

    it('handles site not found', async () => {
      lambdaContext.dataAccess.Site.findById.resolves(null);
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });

  describe('revokeEntitlementSiteModal', () => {
    it('revokes enrollment successfully', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
      expect(client.chat.postMessage).to.have.been.called;
    });

    it('handles errors during revocation', async () => {
      lambdaContext.dataAccess.Site.findById.rejects(new Error('DB error'));
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles errors during individual product revocation', async () => {
      const mockTierClient = {
        revokeSiteEnrollment: sinon.stub().rejects(new Error('Revocation error')),
      };

      const module = await esmock('../../../../src/support/slack/actions/entitlement-modals.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: {
            createForSite: sinon.stub().resolves(mockTierClient),
          },
        },
        '../../../../src/support/slack/actions/entitlement-modal-utils.js': {
          extractSelectedProducts: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
            .then((m) => m.extractSelectedProducts),
          createSayFunction: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
            .then((m) => m.createSayFunction),
          updateMessageToProcessing: mockUpdateMessageToProcessing,
        },
      });

      const handler = module.revokeEntitlementSiteModal(lambdaContext);
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.calledWith(sinon.match('Error revoking'));
    });

    it('handles site not found during revocation', async () => {
      lambdaContext.dataAccess.Site.findById.resolves(null);
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles no products selected during revocation', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
        text: sinon.match(':warning:'),
      }));
    });
  });

  describe('openEnsureEntitlementImsOrgModal', () => {
    it('opens modal for IMS org', async () => {
      const ack = sinon.stub().resolves();
      const client = { views: { open: sinon.stub().resolves() } };
      const body = {
        actions: [{
          value: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
        }],
        trigger_id: 'trigger-123',
      };

      const handler = openEnsureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.views.open).to.have.been.calledOnce;
    });

    it('handles errors when opening ensure IMS org modal', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: { open: sinon.stub().rejects(new Error('Modal error')) },
      };
      const body = {
        actions: [{ value: JSON.stringify({ organizationId: 'org-123', imsOrgId: 'ims@AdobeOrg' }) }],
        trigger_id: 'trigger-123',
      };

      const handler = openEnsureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });

  describe('openRevokeEntitlementSiteModal', () => {
    it('opens revoke modal for site', async () => {
      const ack = sinon.stub().resolves();
      const client = { views: { open: sinon.stub().resolves() } };
      const body = {
        actions: [{
          value: JSON.stringify({
            siteId: 'site-123',
            baseURL: 'https://example.com',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
        }],
        trigger_id: 'trigger-123',
      };

      const handler = openRevokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.views.open).to.have.been.calledOnce;
    });

    it('handles errors when opening revoke site modal', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: { open: sinon.stub().rejects(new Error('Modal error')) },
      };
      const body = {
        actions: [{ value: JSON.stringify({ siteId: 'site-123', baseURL: 'https://example.com' }) }],
        trigger_id: 'trigger-123',
      };

      const handler = openRevokeEntitlementSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });

  describe('openRevokeEntitlementImsOrgModal', () => {
    it('opens revoke modal for IMS org', async () => {
      const ack = sinon.stub().resolves();
      const client = { views: { open: sinon.stub().resolves() } };
      const body = {
        actions: [{
          value: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
        }],
        trigger_id: 'trigger-123',
      };

      const handler = openRevokeEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.views.open).to.have.been.calledOnce;
    });

    it('handles errors when opening revoke IMS org modal', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: { open: sinon.stub().rejects(new Error('Modal error')) },
      };
      const body = {
        actions: [{ value: JSON.stringify({ organizationId: 'org-123', imsOrgId: 'ims@AdobeOrg' }) }],
        trigger_id: 'trigger-123',
      };

      const handler = openRevokeEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });

  describe('ensureEntitlementImsOrgModal', () => {
    it('ensures entitlement for organization', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
    });

    it('handles errors during org entitlement creation', async () => {
      lambdaContext.dataAccess.Organization.findById.rejects(new Error('DB error'));
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles errors during individual product entitlement', async () => {
      const mockTierClient = {
        createEntitlement: sinon.stub().rejects(new Error('Tier error')),
      };

      const module = await esmock('../../../../src/support/slack/actions/entitlement-modals.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: {
            createForOrg: sinon.stub().returns(mockTierClient),
          },
        },
        '../../../../src/support/slack/actions/entitlement-modal-utils.js': {
          extractSelectedProducts: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
            .then((m) => m.extractSelectedProducts),
          createSayFunction: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js')
            .then((m) => m.createSayFunction),
          updateMessageToProcessing: mockUpdateMessageToProcessing,
        },
      });

      const handler = module.ensureEntitlementImsOrgModal(lambdaContext);
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.calledWith(sinon.match('Error creating'));
    });

    it('handles organization not found', async () => {
      lambdaContext.dataAccess.Organization.findById.resolves(null);
      const ack = sinon.stub().resolves();
      const client = { chat: { postMessage: sinon.stub().resolves() } };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles no products selected for org', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = ensureEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
        text: sinon.match(':warning:'),
      }));
    });
  });

  describe('revokeEntitlementImsOrgModal', () => {
    it('revokes entitlement for organization', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack).to.have.been.calledOnce;
      expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
    });

    it('handles no products selected during org revocation', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        chat: { postMessage: sinon.stub().resolves() },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
        text: sinon.match(':warning:'),
      }));
    });

    it('handles errors during org revocation', async () => {
      const mockTierClient = {
        revokeEntitlement: sinon.stub().rejects(new Error('Revocation failed')),
      };

      const module = await esmock('../../../../src/support/slack/actions/entitlement-modals.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: {
            createForOrg: sinon.stub().returns(mockTierClient),
          },
        },
      });

      const handler = module.revokeEntitlementImsOrgModal(lambdaContext);
      const ack = sinon.stub().resolves();
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            orgName: 'Test Org',
            channelId: 'ch-123',
            threadTs: 'thread-123',
            messageTs: 'msg-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });

    it('handles organization not found during revocation', async () => {
      lambdaContext.dataAccess.Organization.findById.resolves(null);
      const ack = sinon.stub().resolves();
      const client = { chat: { postMessage: sinon.stub().resolves() } };
      const body = {
        view: {
          private_metadata: JSON.stringify({
            organizationId: 'org-123',
            imsOrgId: 'ims@AdobeOrg',
            channelId: 'ch-123',
            threadTs: 'thread-123',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [] },
              },
            },
          },
        },
      };

      const handler = revokeEntitlementImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(lambdaContext.log.error).to.have.been.called;
    });
  });
});
