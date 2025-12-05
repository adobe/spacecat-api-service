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

describe('SetImsOrgModal', () => {
  let openSetImsOrgModal;
  let setImsOrgModal;
  let lambdaContext;
  let mockDataAccess;
  let mockLog;
  let mockImsClient;
  let mockTierClient;
  let mockCreateEntitlementsForProducts;
  let mockPostEntitlementMessages;

  before(async () => {
    // Mock TierClient globally
    mockTierClient = {
      createForSite: sinon.stub(),
    };

    // Create stubs for modal-utils functions
    mockCreateEntitlementsForProducts = sinon.stub();
    mockPostEntitlementMessages = sinon.stub();

    const module = await esmock('../../../../src/support/slack/actions/set-ims-org-modal.js', {
      '../../../../src/support/slack/actions/entitlement-modal-utils.js': {
        createProductSelectionModal: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.createProductSelectionModal),
        extractSelectedProducts: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.extractSelectedProducts),
        createSayFunction: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.createSayFunction),
        updateMessageToProcessing: await import('../../../../src/support/slack/actions/entitlement-modal-utils.js').then((m) => m.updateMessageToProcessing),
        createEntitlementsForProducts: mockCreateEntitlementsForProducts,
        postEntitlementMessages: mockPostEntitlementMessages,
      },
    });

    openSetImsOrgModal = module.openSetImsOrgModal;
    setImsOrgModal = module.setImsOrgModal;
  });

  beforeEach(() => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    mockDataAccess = {
      Site: {
        findByBaseURL: sinon.stub(),
      },
      Organization: {
        findByImsOrgId: sinon.stub(),
        create: sinon.stub(),
      },
    };

    mockImsClient = {
      getImsOrganizationDetails: sinon.stub(),
    };

    lambdaContext = {
      log: mockLog,
      dataAccess: mockDataAccess,
      imsClient: mockImsClient,
    };

    // Reset stubs
    mockTierClient.createForSite.reset();
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
  });

  describe('openSetImsOrgModal', () => {
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
            imsOrgId: 'ABC123@AdobeOrg',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openSetImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(client.views.open.calledOnce).to.be.true;

      const openCall = client.views.open.getCall(0);
      const { view } = openCall.args[0];

      expect(view.type).to.equal('modal');
      expect(view.callback_id).to.equal('set_ims_org_modal');
      expect(view.title.text).to.equal('Choose Products');
      expect(view.submit.text).to.equal('Submit');
      expect(view.close.text).to.equal('Cancel');

      const metadata = JSON.parse(view.private_metadata);
      expect(metadata.baseURL).to.equal('https://example.com');
      expect(metadata.imsOrgId).to.equal('ABC123@AdobeOrg');
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
            imsOrgId: 'ABC123@AdobeOrg',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openSetImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      const openCall = client.views.open.getCall(0);
      const { view } = openCall.args[0];
      const actionsBlock = view.blocks.find((b) => b.type === 'actions');

      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.lengthOf(2);
      expect(actionsBlock.elements[0].type).to.equal('checkboxes');
      expect(actionsBlock.elements[1].type).to.equal('checkboxes');
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
            imsOrgId: 'ABC123@AdobeOrg',
            channelId: 'C123',
            threadTs: '1234567890.123456',
            messageTs: '1234567890.123457',
          }),
        }],
      };

      const handler = openSetImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Error opening modal:')).to.be.true;
    });
  });

  describe('setImsOrgModal', () => {
    it('proceeds without entitlements if no products selected (existing org)', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site123',
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      const mockOrg = {
        getId: () => 'org123',
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrg);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'ABC123@AdobeOrg',
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
        user: { id: 'U123' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(mockSite.setOrganizationId.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
      expect(mockCreateEntitlementsForProducts.called).to.be.false;
      expect(mockPostEntitlementMessages.called).to.be.false;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Successfully updated site');
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':warning:');
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('No products selected');
    });

    it('creates new org without entitlements if no products selected', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site123',
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      const mockOrg = {
        getId: () => 'org123',
        save: sinon.stub().resolves(),
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.create.returns(mockOrg);
      mockImsClient.getImsOrganizationDetails.resolves({ orgName: 'New Test Org' });

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'ABC123@AdobeOrg',
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
        user: { id: 'U123' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(mockDataAccess.Organization.create.calledOnce).to.be.true;
      expect(mockOrg.save.calledOnce).to.be.true;
      expect(mockSite.setOrganizationId.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
      expect(mockCreateEntitlementsForProducts.called).to.be.false;
      expect(mockPostEntitlementMessages.called).to.be.false;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Successfully *created*');
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':warning:');
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('No products selected');
    });

    it('creates new organization and entitlements when org not found', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site123',
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      const mockOrg = {
        getId: () => 'org123',
        save: sinon.stub().resolves(),
      };
      const mockEntitlement = {
        getId: () => 'entitlement123',
      };
      const mockSiteEnrollment = {
        getId: () => 'enrollment123',
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.create.returns(mockOrg);
      mockImsClient.getImsOrganizationDetails.resolves({ orgName: 'Test Org' });

      mockCreateEntitlementsForProducts.resolves([
        { product: 'ASO', entitlementId: mockEntitlement.getId(), enrollmentId: mockSiteEnrollment.getId() },
        { product: 'LLMO', entitlementId: mockEntitlement.getId(), enrollmentId: mockSiteEnrollment.getId() },
      ]);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'ABC123@AdobeOrg',
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
        user: { id: 'U123' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(mockDataAccess.Organization.create.calledWith({
        name: 'Test Org',
        imsOrgId: 'ABC123@AdobeOrg',
      })).to.be.true;
      expect(mockOrg.save.calledOnce).to.be.true;
      expect(mockSite.setOrganizationId.calledWith('org123')).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;

      // Check button was removed
      expect(client.chat.update.calledOnce).to.be.true;
      const updateCall = client.chat.update.getCall(0);
      expect(updateCall.args[0].ts).to.equal('1234567890.123457');

      // Check success message
      expect(client.chat.postMessage.calledOnce).to.be.true; // 1 success message
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Successfully *created*');

      // Check entitlements were created and messages posted
      expect(mockCreateEntitlementsForProducts.calledOnce).to.be.true;
      expect(mockPostEntitlementMessages.calledOnce).to.be.true;
    });

    it('updates existing organization and creates entitlements', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site456',
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      const mockOrg = {
        getId: () => 'org456',
      };
      const mockEntitlement = {
        getId: () => 'entitlement456',
      };
      const mockSiteEnrollment = {
        getId: () => 'enrollment456',
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrg);

      mockCreateEntitlementsForProducts.resolves([
        { product: 'ASO', entitlementId: mockEntitlement.getId(), enrollmentId: mockSiteEnrollment.getId() },
      ]);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'DEF456@AdobeOrg',
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
        user: { id: 'U456' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(ack.calledOnce).to.be.true;
      expect(mockSite.setOrganizationId.calledWith('org456')).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;

      // Check success message
      expect(client.chat.postMessage.calledOnce).to.be.true; // 1 success message
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include('Successfully updated site');

      // Check entitlements were created and messages posted
      expect(mockCreateEntitlementsForProducts.calledOnce).to.be.true;
      expect(mockPostEntitlementMessages.calledOnce).to.be.true;
    });

    it('handles site not found error', async () => {
      const ack = sinon.stub().resolves();
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://notfound.com',
            imsOrgId: 'ABC123@AdobeOrg',
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
        user: { id: 'U123' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Site not found: https://notfound.com')).to.be.true;
      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':x: Site not found');
    });

    it('handles IMS org not found error', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site789',
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockImsClient.getImsOrganizationDetails.resolves(null);

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'NOTFOUND@AdobeOrg',
            channelId: 'C789',
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
        user: { id: 'U789' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':x: Could not find an IMS org');
    });

    it('handles IMS client errors', async () => {
      const ack = sinon.stub().resolves();
      const mockSite = {
        getId: () => 'site999',
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockImsClient.getImsOrganizationDetails.rejects(new Error('IMS Error'));

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'ERROR@AdobeOrg',
            channelId: 'C999',
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
        user: { id: 'U999' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Error retrieving IMS Org details: IMS Error')).to.be.true;
      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.include(':x: Could not find an IMS org');
    });

    it('handles general errors gracefully', async () => {
      const ack = sinon.stub().resolves();
      mockDataAccess.Site.findByBaseURL.rejects(new Error('Database error'));

      const body = {
        view: {
          private_metadata: JSON.stringify({
            baseURL: 'https://example.com',
            imsOrgId: 'ABC123@AdobeOrg',
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
        user: { id: 'U123' },
      };
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
          update: sinon.stub().resolves(),
        },
      };

      const handler = setImsOrgModal(lambdaContext);
      await handler({ ack, body, client });

      expect(mockLog.error.calledWith('Error handling modal submission:')).to.be.true;
    });
  });
});
