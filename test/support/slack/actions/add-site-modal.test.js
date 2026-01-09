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

describe('AddSiteModal', () => {
  let openAddSiteModal;
  let addSiteModal;
  let lambdaContext;
  let mockDataAccess;
  let mockLog;
  let mockEnv;
  let mockTierClient;
  let mockSqs;
  let triggerAuditForSiteStub;
  let mockCreateEntitlementsForProducts;
  let mockPostEntitlementMessages;

  before(async () => {
    // Mock TierClient globally
    mockTierClient = {
      createForSite: sinon.stub(),
    };

    triggerAuditForSiteStub = sinon.stub();

    // Create stubs for modal-utils functions
    mockCreateEntitlementsForProducts = sinon.stub();
    mockPostEntitlementMessages = sinon.stub();

    const module = await esmock('../../../../src/support/slack/actions/add-site-modal.js', {
      '../../../../src/support/slack/actions/entitlement-modal-utils.js': {
        createProductSelectionModal: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.createProductSelectionModal),
        extractSelectedProducts: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.extractSelectedProducts),
        createSayFunction: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.createSayFunction),
        updateMessageToProcessing: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.updateMessageToProcessing),
        createEntitlementsForProducts: mockCreateEntitlementsForProducts,
        postEntitlementMessages: mockPostEntitlementMessages,
      },
      '../../../../src/support/utils.js': {
        triggerAuditForSite: triggerAuditForSiteStub,
      },
    });

    openAddSiteModal = module.openAddSiteModal;
    addSiteModal = module.addSiteModal;
  });

  beforeEach(() => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    mockDataAccess = {
      Site: {
        findById: sinon.stub(),
      },
      Configuration: {
        findLatest: sinon.stub(),
      },
    };

    mockEnv = {
      AUDIT_JOBS_QUEUE_URL: 'testQueueUrl',
    };

    mockSqs = {
      sendMessage: sinon.stub().resolves(),
    };

    lambdaContext = {
      log: mockLog,
      dataAccess: mockDataAccess,
      env: mockEnv,
      sqs: mockSqs,
    };

    // Reset stubs
    mockTierClient.createForSite.reset();
    triggerAuditForSiteStub.reset();
    mockCreateEntitlementsForProducts.reset();
    mockPostEntitlementMessages.reset();

    // Configure default return values
    mockCreateEntitlementsForProducts.resolves([
      {
        product: 'ASO',
        entitlementId: 'entitlement-id-1',
        enrollmentId: 'enrollment-id-1',
      },
    ]);
    mockPostEntitlementMessages.resolves();
    triggerAuditForSiteStub.resolves();
  });

  describe('openAddSiteModal', () => {
    it('opens modal with correct structure', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: {
          open: sinon.stub().resolves(),
        },
      };
      const body = {
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openAddSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(client.views.open.calledOnce).to.be.true;

      const openCall = client.views.open.getCall(0);
      const { view } = openCall.args[0];

      expect(view.type).to.equal('modal');
      expect(view.callback_id).to.equal('add_site_modal');
      expect(view.title.text).to.equal('Choose Products');
      expect(view.submit.text).to.equal('Submit');
      expect(view.close.text).to.equal('Cancel');

      const metadata = JSON.parse(view.private_metadata);
      expect(metadata.baseURL).to.equal('https://example.com');
      expect(metadata.siteId).to.equal('site123');
      expect(metadata.messageTs).to.equal('1234567890.123457');
    });

    it('includes ASO and LLMO checkboxes', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: {
          open: sinon.stub().resolves(),
        },
      };
      const body = {
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openAddSiteModal(lambdaContext);
      await handler({ ack, body, client });

      const openCall = client.views.open.getCall(0);
      const { view } = openCall.args[0];
      const actionsBlock = view.blocks.find((b) => b.type === 'actions');

      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.lengthOf(3);
      expect(actionsBlock.elements[0].type).to.equal('checkboxes');
      expect(actionsBlock.elements[1].type).to.equal('checkboxes');
      expect(actionsBlock.elements[2].type).to.equal('checkboxes');
    });

    it('handles errors when opening modal', async () => {
      const ack = sinon.stub().resolves();
      const client = {
        views: {
          open: sinon.stub().rejects(new Error('Modal error')),
        },
      };
      const body = {
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openAddSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Error opening modal:')).to.be.true;
    });
  });

  describe('addSiteModal', () => {
    it('returns error if no products selected', async () => {
      const ack = sinon.stub().resolves();
      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
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
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Please select at least one product');
    });

    it('handles site not found error', async () => {
      const ack = sinon.stub().resolves();
      mockDataAccess.Site.findById.resolves(null);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://notfound.com',
            siteId: 'site999',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
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
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Site not found: site999')).to.be.true;
      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':x: Site not found');
    });

    it('creates entitlements and triggers audit when enabled', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site123',
        getBaseURL: () => 'https://example.com',
      };
      const mockEntitlement = {
        getId: () => 'entitlement123',
      };
      const mockSiteEnrollment = {
        getId: () => 'enrollment123',
      };
      const mockConfiguration = {
        isHandlerEnabledForSite: sinon.stub().returns(true),
      };

      mockDataAccess.Site.findById.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      mockTierClient.createForSite.returns({
        createEntitlement: sinon.stub().resolves({
          entitlement: mockEntitlement,
          siteEnrollment: mockSiteEnrollment,
        }),
      });

      triggerAuditForSiteStub.resolves();

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [{ value: 'ASO' }] },
                llmo_checkbox: { selected_options: [{ value: 'LLMO' }] },
              },
            },
          },
        },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(mockDataAccess.Site.findById.calledWith('site123')).to.be.true;

      // Check button was removed
      expect(client.chat.update.calledOnce).to.be.true;
      const updateCall = client.chat.update.getCall(0);
      expect(updateCall.args[0].ts).to.equal('1234567890.123457');

      // Check success messages (1 for products selected + 1 for audit)
      expect(client.chat.postMessage.callCount).to.equal(2);
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Products selected');
      expect(client.chat.postMessage.getCall(1).args[0].text).to.include('First PSI check is triggered');

      // Check entitlements were created and messages posted
      expect(mockCreateEntitlementsForProducts.calledOnce).to.be.true;
      expect(mockPostEntitlementMessages.calledOnce).to.be.true;

      // Check audit was triggered
      expect(triggerAuditForSiteStub.calledOnce).to.be.true;
      expect(triggerAuditForSiteStub.getCall(0).args[0]).to.equal(mockSite);
      expect(triggerAuditForSiteStub.getCall(0).args[1]).to.equal('lhs-mobile');
    });

    it('creates entitlements but does not trigger audit when disabled', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site456',
        getBaseURL: () => 'https://example.com',
      };
      const mockEntitlement = {
        getId: () => 'entitlement456',
      };
      const mockSiteEnrollment = {
        getId: () => 'enrollment456',
      };
      const mockConfiguration = {
        isHandlerEnabledForSite: sinon.stub().returns(false),
      };

      mockDataAccess.Site.findById.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      mockTierClient.createForSite.returns({
        createEntitlement: sinon.stub().resolves({
          entitlement: mockEntitlement,
          siteEnrollment: mockSiteEnrollment,
        }),
      });

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site456',
            channelId: 'C456',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
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
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;

      // Check success messages (1 for products selected + 1 for audits disabled)
      expect(client.chat.postMessage.callCount).to.equal(2);
      expect(client.chat.postMessage.getCall(1).args[0].text).to.include('Audits are disabled');

      // Check entitlements were created and messages posted
      expect(mockCreateEntitlementsForProducts.calledOnce).to.be.true;
      expect(mockPostEntitlementMessages.calledOnce).to.be.true;

      // Check audit was NOT triggered
      expect(triggerAuditForSiteStub.called).to.be.false;
    });

    it('creates only selected product entitlements', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site789',
        getBaseURL: () => 'https://example.com',
      };
      const mockEntitlement = {
        getId: () => 'entitlement789',
      };
      const mockSiteEnrollment = {
        getId: () => 'enrollment789',
      };
      const mockConfiguration = {
        isHandlerEnabledForSite: sinon.stub().returns(true),
      };

      mockDataAccess.Site.findById.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      mockTierClient.createForSite.returns({
        createEntitlement: sinon.stub().resolves({
          entitlement: mockEntitlement,
          siteEnrollment: mockSiteEnrollment,
        }),
      });

      triggerAuditForSiteStub.resolves();

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site789',
            channelId: 'C789',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
          state: {
            values: {
              products_block: {
                aso_checkbox: { selected_options: [] },
                llmo_checkbox: { selected_options: [{ value: 'LLMO' }] },
              },
            },
          },
        },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;

      // Check only LLMO entitlement was created (1 for products selected + 1 for audit)
      expect(client.chat.postMessage.callCount).to.equal(2);
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('LLMO');

      // Check entitlements were created and messages posted
      expect(mockCreateEntitlementsForProducts.calledOnce).to.be.true;
      expect(mockPostEntitlementMessages.calledOnce).to.be.true;
    });

    it('handles general errors gracefully', async () => {
      const ack = sinon.stub().resolves();
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            siteId: 'site123',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
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
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = addSiteModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Error handling modal submission:')).to.be.true;
    });
  });
});
