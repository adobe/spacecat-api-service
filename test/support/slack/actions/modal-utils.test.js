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
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';

use(sinonChai);

describe('Modal Utils', () => {
  let modalUtils;
  let mockTierClient;

  before(async () => {
    mockTierClient = {
      createForSite: sinon.stub(),
    };

    modalUtils = await esmock('../../../../src/support/slack/actions/modal-utils.js', {
      '@adobe/spacecat-shared-tier-client': {
        default: mockTierClient,
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createProductSelectionModal', () => {
    it('creates a modal with all required fields', () => {
      const callbackId = 'test_modal';
      const metadata = { baseURL: 'https://example.com', siteId: 'site123' };
      const title = 'Test Modal';
      const description = '*Test Description*\n\nSite: `https://example.com`';

      const modal = modalUtils.createProductSelectionModal(
        callbackId,
        metadata,
        title,
        description,
      );

      expect(modal.type).to.equal('modal');
      expect(modal.callback_id).to.equal(callbackId);
      expect(modal.title.text).to.equal(title);
      expect(modal.submit.text).to.equal('Submit');
      expect(modal.close.text).to.equal('Cancel');
      expect(JSON.parse(modal.private_metadata)).to.deep.equal(metadata);
    });

    it('includes section with description', () => {
      const description = '*Choose products*\n\nSite: `https://example.com`';
      const modal = modalUtils.createProductSelectionModal(
        'test_modal',
        {},
        'Test',
        description,
      );

      const sectionBlock = modal.blocks.find((b) => b.type === 'section');
      expect(sectionBlock).to.exist;
      expect(sectionBlock.text.type).to.equal('mrkdwn');
      expect(sectionBlock.text.text).to.equal(description);
    });

    it('includes divider block', () => {
      const modal = modalUtils.createProductSelectionModal(
        'test_modal',
        {},
        'Test',
        'Description',
      );

      const dividerBlock = modal.blocks.find((b) => b.type === 'divider');
      expect(dividerBlock).to.exist;
    });

    it('includes ASO and LLMO checkboxes', () => {
      const modal = modalUtils.createProductSelectionModal(
        'test_modal',
        {},
        'Test',
        'Description',
      );

      const actionsBlock = modal.blocks.find((b) => b.type === 'actions');
      expect(actionsBlock).to.exist;
      expect(actionsBlock.block_id).to.equal('products_block');
      expect(actionsBlock.elements).to.have.lengthOf(2);

      const asoCheckbox = actionsBlock.elements[0];
      expect(asoCheckbox.type).to.equal('checkboxes');
      expect(asoCheckbox.action_id).to.equal('aso_checkbox');
      expect(asoCheckbox.options[0].value).to.equal(EntitlementModel.PRODUCT_CODES.ASO);

      const llmoCheckbox = actionsBlock.elements[1];
      expect(llmoCheckbox.type).to.equal('checkboxes');
      expect(llmoCheckbox.action_id).to.equal('llmo_checkbox');
      expect(llmoCheckbox.options[0].value).to.equal(EntitlementModel.PRODUCT_CODES.LLMO);
    });
  });

  describe('extractSelectedProducts', () => {
    it('extracts both ASO and LLMO when selected', () => {
      const state = {
        values: {
          products_block: {
            aso_checkbox: { selected_options: [{ value: 'ASO' }] },
            llmo_checkbox: { selected_options: [{ value: 'LLMO' }] },
          },
        },
      };

      const products = modalUtils.extractSelectedProducts(state);

      expect(products).to.deep.equal(['ASO', 'LLMO']);
    });

    it('extracts only ASO when only ASO is selected', () => {
      const state = {
        values: {
          products_block: {
            aso_checkbox: { selected_options: [{ value: 'ASO' }] },
            llmo_checkbox: { selected_options: [] },
          },
        },
      };

      const products = modalUtils.extractSelectedProducts(state);

      expect(products).to.deep.equal(['ASO']);
    });

    it('extracts only LLMO when only LLMO is selected', () => {
      const state = {
        values: {
          products_block: {
            aso_checkbox: { selected_options: [] },
            llmo_checkbox: { selected_options: [{ value: 'LLMO' }] },
          },
        },
      };

      const products = modalUtils.extractSelectedProducts(state);

      expect(products).to.deep.equal(['LLMO']);
    });

    it('returns empty array when no products are selected', () => {
      const state = {
        values: {
          products_block: {
            aso_checkbox: { selected_options: [] },
            llmo_checkbox: { selected_options: [] },
          },
        },
      };

      const products = modalUtils.extractSelectedProducts(state);

      expect(products).to.deep.equal([]);
    });
  });

  describe('createSayFunction', () => {
    it('creates a function that posts messages to the correct channel', async () => {
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
        },
      };
      const channelId = 'C123456';
      const threadTs = '1234567890.123456';

      const say = modalUtils.createSayFunction(client, channelId, threadTs);

      await say('Test message');

      expect(client.chat.postMessage.calledOnce).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0]).to.deep.equal({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Test message',
      });
    });

    it('can be called multiple times', async () => {
      const client = {
        chat: {
          postMessage: sinon.stub().resolves(),
        },
      };

      const say = modalUtils.createSayFunction(client, 'C123', '1234567890.123456');

      await say('Message 1');
      await say('Message 2');

      expect(client.chat.postMessage.calledTwice).to.be.true;
      expect(client.chat.postMessage.getCall(0).args[0].text).to.equal('Message 1');
      expect(client.chat.postMessage.getCall(1).args[0].text).to.equal('Message 2');
    });
  });

  describe('updateMessageToProcessing', () => {
    it('updates message with processing state', async () => {
      const client = {
        chat: {
          update: sinon.stub().resolves(),
        },
      };
      const channelId = 'C123456';
      const messageTs = '1234567890.123457';
      const baseURL = 'https://example.com';
      const title = 'Test Operation';

      await modalUtils.updateMessageToProcessing(
        client,
        channelId,
        messageTs,
        baseURL,
        title,
      );

      expect(client.chat.update.calledOnce).to.be.true;
      const updateCall = client.chat.update.getCall(0).args[0];
      expect(updateCall.channel).to.equal(channelId);
      expect(updateCall.ts).to.equal(messageTs);
      expect(updateCall.text).to.include(baseURL);
      expect(updateCall.blocks[0].text.text).to.include(title);
      expect(updateCall.blocks[0].text.text).to.include(baseURL);
      expect(updateCall.blocks[0].text.text).to.include('_Processing..._');
    });
  });

  describe('createEntitlementsForProducts', () => {
    it('creates entitlements for multiple products in parallel', async () => {
      const mockSite = { getId: () => 'site123' };
      const mockLambdaContext = { env: {}, log: {} };
      const selectedProducts = ['ASO', 'LLMO'];

      const mockEntitlement1 = { getId: () => 'entitlement-aso' };
      const mockEnrollment1 = { getId: () => 'enrollment-aso' };
      const mockEntitlement2 = { getId: () => 'entitlement-llmo' };
      const mockEnrollment2 = { getId: () => 'enrollment-llmo' };

      mockTierClient.createForSite
        .onFirstCall().returns({
          createEntitlement: sinon.stub().resolves({
            entitlement: mockEntitlement1,
            siteEnrollment: mockEnrollment1,
          }),
        })
        .onSecondCall().returns({
          createEntitlement: sinon.stub().resolves({
            entitlement: mockEntitlement2,
            siteEnrollment: mockEnrollment2,
          }),
        });

      const results = await modalUtils.createEntitlementsForProducts(
        mockLambdaContext,
        mockSite,
        selectedProducts,
      );

      expect(mockTierClient.createForSite.calledTwice).to.be.true;
      expect(results).to.have.lengthOf(2);
      expect(results[0]).to.deep.equal({
        product: 'ASO',
        entitlementId: 'entitlement-aso',
        enrollmentId: 'enrollment-aso',
      });
      expect(results[1]).to.deep.equal({
        product: 'LLMO',
        entitlementId: 'entitlement-llmo',
        enrollmentId: 'enrollment-llmo',
      });
    });

    it('creates entitlement for single product', async () => {
      const mockSite = { getId: () => 'site456' };
      const mockLambdaContext = { env: {}, log: {} };
      const selectedProducts = ['ASO'];

      const mockEntitlement = { getId: () => 'entitlement-123' };
      const mockEnrollment = { getId: () => 'enrollment-123' };

      mockTierClient.createForSite.returns({
        createEntitlement: sinon.stub().resolves({
          entitlement: mockEntitlement,
          siteEnrollment: mockEnrollment,
        }),
      });

      const results = await modalUtils.createEntitlementsForProducts(
        mockLambdaContext,
        mockSite,
        selectedProducts,
      );

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.deep.equal({
        product: 'ASO',
        entitlementId: 'entitlement-123',
        enrollmentId: 'enrollment-123',
      });
    });

    it('returns empty array for empty product list', async () => {
      const mockSite = { getId: () => 'site789' };
      const mockLambdaContext = { env: {}, log: {} };
      const selectedProducts = [];

      // Reset the stub before this test
      mockTierClient.createForSite.resetHistory();

      const results = await modalUtils.createEntitlementsForProducts(
        mockLambdaContext,
        mockSite,
        selectedProducts,
      );

      expect(results).to.deep.equal([]);
      expect(mockTierClient.createForSite.called).to.be.false;
    });
  });

  describe('postEntitlementMessages', () => {
    it('posts messages for multiple entitlement results', async () => {
      const say = sinon.stub().resolves();
      const entitlementResults = [
        { product: 'ASO', entitlementId: 'ent-1', enrollmentId: 'enr-1' },
        { product: 'LLMO', entitlementId: 'ent-2', enrollmentId: 'enr-2' },
      ];
      const siteId = 'site123';

      await modalUtils.postEntitlementMessages(say, entitlementResults, siteId);

      expect(say.calledTwice).to.be.true;
      expect(say.getCall(0).args[0]).to.include('ASO');
      expect(say.getCall(0).args[0]).to.include('ent-1');
      expect(say.getCall(0).args[0]).to.include('enr-1');
      expect(say.getCall(0).args[0]).to.include('site123');
      expect(say.getCall(0).args[0]).to.include(EntitlementModel.TIERS.FREE_TRIAL);

      expect(say.getCall(1).args[0]).to.include('LLMO');
      expect(say.getCall(1).args[0]).to.include('ent-2');
      expect(say.getCall(1).args[0]).to.include('enr-2');
      expect(say.getCall(1).args[0]).to.include('site123');
    });

    it('posts message for single entitlement result', async () => {
      const say = sinon.stub().resolves();
      const entitlementResults = [
        { product: 'ASO', entitlementId: 'ent-123', enrollmentId: 'enr-456' },
      ];
      const siteId = 'site789';

      await modalUtils.postEntitlementMessages(say, entitlementResults, siteId);

      expect(say.calledOnce).to.be.true;
      expect(say.getCall(0).args[0]).to.include('ASO');
      expect(say.getCall(0).args[0]).to.include('ent-123');
      expect(say.getCall(0).args[0]).to.include('enr-456');
      expect(say.getCall(0).args[0]).to.include('site789');
    });

    it('does not post messages for empty results', async () => {
      const say = sinon.stub().resolves();
      const entitlementResults = [];
      const siteId = 'site999';

      await modalUtils.postEntitlementMessages(say, entitlementResults, siteId);

      expect(say.called).to.be.false;
    });
  });
});
