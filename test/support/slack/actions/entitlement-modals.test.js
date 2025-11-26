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

  // Test data constants
  const TEST_IDS = {
    site: 'site-123',
    org: 'org-123',
    channel: 'ch-123',
    thread: 'thread-123',
    message: 'msg-123',
    trigger: 'trigger-123',
    ent: 'ent-123',
  };

  const TEST_URLS = {
    site: 'https://example.com',
    imsOrg: 'ims@AdobeOrg',
  };

  // Helper to create standard product selection state
  const createProductState = (asoSelected = true, llmoSelected = false) => ({
    products_block: {
      aso_checkbox: { selected_options: asoSelected ? [{ value: 'ASO' }] : [] },
      llmo_checkbox: { selected_options: llmoSelected ? [{ value: 'LLMO' }] : [] },
    },
  });

  // Helper to create site modal metadata
  const createSiteMetadata = (includeMessage = true) => ({
    siteId: TEST_IDS.site,
    baseURL: TEST_URLS.site,
    channelId: TEST_IDS.channel,
    threadTs: TEST_IDS.thread,
    ...(includeMessage && { messageTs: TEST_IDS.message }),
  });

  // Helper to create org modal metadata
  const createOrgMetadata = (includeMessage = true) => ({
    organizationId: TEST_IDS.org,
    imsOrgId: TEST_URLS.imsOrg,
    orgName: 'Test Org',
    channelId: TEST_IDS.channel,
    threadTs: TEST_IDS.thread,
    ...(includeMessage && { messageTs: TEST_IDS.message }),
  });

  // Helper to create standard client mock
  const createClientMock = (openRejects = false) => ({
    views: {
      open: openRejects
        ? sinon.stub().rejects(new Error('Modal error'))
        : sinon.stub().resolves(),
    },
    chat: {
      postMessage: sinon.stub().resolves(),
      update: sinon.stub().resolves(),
    },
  });

  // Helper to create modal submission body
  const createModalBody = (metadata, products = createProductState()) => ({
    view: {
      private_metadata: JSON.stringify(metadata),
      state: { values: products },
    },
  });

  // Helper to create action body for opening modals
  const createActionBody = (metadata) => ({
    actions: [{ value: JSON.stringify(metadata) }],
    trigger_id: TEST_IDS.trigger,
  });

  // Helper to test modal opening
  const testModalOpening = async (handlerFn, metadata, expectError = false) => {
    const ack = sinon.stub().resolves();
    const client = createClientMock(expectError);
    const body = createActionBody(metadata);

    const handler = handlerFn(lambdaContext);
    await handler({ ack, body, client });

    expect(ack).to.have.been.calledOnce;
    if (expectError) {
      expect(lambdaContext.log.error).to.have.been.called;
    } else {
      expect(client.views.open).to.have.been.calledOnce;
    }
  };

  // Helper to test modal submission
  const testModalSubmission = async (handlerFn, metadata, products, assertions) => {
    const ack = sinon.stub().resolves();
    const client = createClientMock();
    const body = createModalBody(metadata, products);

    const handler = handlerFn(lambdaContext);
    await handler({ ack, body, client });

    assertions(ack, client);
  };

  before(async () => {
    mockCreateEntitlementsForProducts = sinon.stub().resolves([
      { product: 'ASO', entitlementId: TEST_IDS.ent, enrollmentId: 'enr-1' },
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
              entitlement: { getId: () => TEST_IDS.ent },
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
            getId: () => TEST_IDS.site,
            getBaseURL: () => TEST_URLS.site,
          }),
        },
        Organization: {
          findById: sinon.stub().resolves({
            getId: () => TEST_IDS.org,
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
    it('opens modal with correct metadata', () => testModalOpening(
      openEnsureEntitlementSiteModal,
      createSiteMetadata(),
    ));

    it('handles errors when opening modal', () => testModalOpening(
      openEnsureEntitlementSiteModal,
      { siteId: TEST_IDS.site, baseURL: TEST_URLS.site },
      true,
    ));
  });

  describe('ensureEntitlementSiteModal', () => {
    it('processes modal submission successfully', () => testModalSubmission(
      ensureEntitlementSiteModal,
      createSiteMetadata(),
      createProductState(),
      (ack) => {
        expect(ack).to.have.been.calledOnce;
        expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
        expect(mockCreateEntitlementsForProducts).to.have.been.calledOnce;
      },
    ));

    it('handles errors during entitlement creation', async () => {
      mockCreateEntitlementsForProducts.rejects(new Error('Creation failed'));
      await testModalSubmission(
        ensureEntitlementSiteModal,
        createSiteMetadata(),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });

    it('handles no products selected', () => testModalSubmission(
      ensureEntitlementSiteModal,
      createSiteMetadata(false),
      createProductState(false, false),
      (ack, client) => {
        expect(ack).to.have.been.calledOnce;
        expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
          text: sinon.match(':warning:'),
        }));
      },
    ));

    it('handles site not found', async () => {
      lambdaContext.dataAccess.Site.findById.resolves(null);
      await testModalSubmission(
        ensureEntitlementSiteModal,
        createSiteMetadata(false),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });
  });

  describe('revokeEntitlementSiteModal', () => {
    it('revokes enrollment successfully', () => testModalSubmission(
      revokeEntitlementSiteModal,
      createSiteMetadata(),
      createProductState(),
      (ack, client) => {
        expect(ack).to.have.been.calledOnce;
        expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
        expect(client.chat.postMessage).to.have.been.called;
      },
    ));

    it('handles errors during revocation', async () => {
      lambdaContext.dataAccess.Site.findById.rejects(new Error('DB error'));
      await testModalSubmission(
        revokeEntitlementSiteModal,
        createSiteMetadata(),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
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

      await testModalSubmission(
        module.revokeEntitlementSiteModal,
        createSiteMetadata(),
        createProductState(),
        () => {
          expect(lambdaContext.log.error).to.have.been.calledWith(sinon.match('Error revoking'));
        },
      );
    });

    it('handles site not found during revocation', async () => {
      lambdaContext.dataAccess.Site.findById.resolves(null);
      await testModalSubmission(
        revokeEntitlementSiteModal,
        createSiteMetadata(false),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });

    it('handles no products selected during revocation', () => testModalSubmission(
      revokeEntitlementSiteModal,
      createSiteMetadata(false),
      createProductState(false, false),
      (ack, client) => {
        expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
          text: sinon.match(':warning:'),
        }));
      },
    ));
  });

  describe('openEnsureEntitlementImsOrgModal', () => {
    it('opens modal for IMS org', () => testModalOpening(
      openEnsureEntitlementImsOrgModal,
      createOrgMetadata(),
    ));

    it('handles errors when opening ensure IMS org modal', () => testModalOpening(
      openEnsureEntitlementImsOrgModal,
      { organizationId: TEST_IDS.org, imsOrgId: TEST_URLS.imsOrg },
      true,
    ));
  });

  describe('openRevokeEntitlementSiteModal', () => {
    it('opens revoke modal for site', () => testModalOpening(
      openRevokeEntitlementSiteModal,
      createSiteMetadata(),
    ));

    it('handles errors when opening revoke site modal', () => testModalOpening(
      openRevokeEntitlementSiteModal,
      { siteId: TEST_IDS.site, baseURL: TEST_URLS.site },
      true,
    ));
  });

  describe('openRevokeEntitlementImsOrgModal', () => {
    it('opens revoke modal for IMS org', () => testModalOpening(
      openRevokeEntitlementImsOrgModal,
      createOrgMetadata(),
    ));

    it('handles errors when opening revoke IMS org modal', () => testModalOpening(
      openRevokeEntitlementImsOrgModal,
      { organizationId: TEST_IDS.org, imsOrgId: TEST_URLS.imsOrg },
      true,
    ));
  });

  describe('ensureEntitlementImsOrgModal', () => {
    it('ensures entitlement for organization', () => testModalSubmission(
      ensureEntitlementImsOrgModal,
      createOrgMetadata(),
      createProductState(),
      (ack) => {
        expect(ack).to.have.been.calledOnce;
        expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
      },
    ));

    it('handles errors during org entitlement creation', async () => {
      lambdaContext.dataAccess.Organization.findById.rejects(new Error('DB error'));
      await testModalSubmission(
        ensureEntitlementImsOrgModal,
        createOrgMetadata(),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
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

      await testModalSubmission(
        module.ensureEntitlementImsOrgModal,
        createOrgMetadata(),
        createProductState(),
        () => {
          expect(lambdaContext.log.error).to.have.been.calledWith(sinon.match('Error creating'));
        },
      );
    });

    it('handles organization not found', async () => {
      lambdaContext.dataAccess.Organization.findById.resolves(null);
      await testModalSubmission(
        ensureEntitlementImsOrgModal,
        createOrgMetadata(false),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });

    it('handles no products selected for org', () => testModalSubmission(
      ensureEntitlementImsOrgModal,
      createOrgMetadata(false),
      createProductState(false, false),
      (ack, client) => {
        expect(ack).to.have.been.calledOnce;
        expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
          text: sinon.match(':warning:'),
        }));
      },
    ));
  });

  describe('revokeEntitlementImsOrgModal', () => {
    it('revokes entitlement for organization', () => testModalSubmission(
      revokeEntitlementImsOrgModal,
      createOrgMetadata(),
      createProductState(),
      (ack) => {
        expect(ack).to.have.been.calledOnce;
        expect(mockUpdateMessageToProcessing).to.have.been.calledOnce;
      },
    ));

    it('handles no products selected during org revocation', () => testModalSubmission(
      revokeEntitlementImsOrgModal,
      createOrgMetadata(false),
      createProductState(false, false),
      (ack, client) => {
        expect(client.chat.postMessage).to.have.been.calledWith(sinon.match({
          text: sinon.match(':warning:'),
        }));
      },
    ));

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

      await testModalSubmission(
        module.revokeEntitlementImsOrgModal,
        createOrgMetadata(),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });

    it('handles organization not found during revocation', async () => {
      lambdaContext.dataAccess.Organization.findById.resolves(null);
      await testModalSubmission(
        revokeEntitlementImsOrgModal,
        createOrgMetadata(false),
        createProductState(),
        () => { expect(lambdaContext.log.error).to.have.been.called; },
      );
    });
  });
});
