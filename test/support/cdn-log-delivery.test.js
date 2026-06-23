/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('cdn-log-delivery support', () => {
  let logsSendStub;
  let cdnLogDelivery;

  const CREDS = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' };
  const IMS_ORG = '1234567890ABCDEF12345678@AdobeOrg';
  const SAFE_ORG = '1234567890abcdef12345678';
  const ACCOUNT = '123456789012';
  const DIST = 'E1ABCDEF';
  const DEST_ARN = `arn:aws:logs:us-east-1:111122223333:delivery-destination:cdn-logs-${SAFE_ORG}`;

  before(async function setupEsmock() {
    this.timeout(120000);
    const logsCommand = (Name) => function LogsCommand(input) {
      this.input = input;
      this.commandName = Name;
    };
    cdnLogDelivery = await esmock('../../src/support/cdn-log-delivery.js', {
      '@aws-sdk/client-cloudwatch-logs': {
        CloudWatchLogsClient: function CloudWatchLogsClient(config) {
          this.config = config;
          this.send = (cmd) => logsSendStub(cmd);
        },
        PutDeliverySourceCommand: logsCommand('PutDeliverySource'),
        CreateDeliveryCommand: logsCommand('CreateDelivery'),
        GetDeliverySourceCommand: logsCommand('GetDeliverySource'),
        DescribeDeliveriesCommand: logsCommand('DescribeDeliveries'),
      },
    });
  });

  beforeEach(() => {
    logsSendStub = sinon.stub();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('toSafeAwsName', () => {
    it('strips @AdobeOrg, drops @, lowercases', () => {
      expect(cdnLogDelivery.toSafeAwsName(IMS_ORG)).to.equal(SAFE_ORG);
    });
  });

  describe('buildDeliveryDestinationArn', () => {
    it('builds the cdn-logs-<org> destination ARN (no -ams suffix)', () => {
      const arn = cdnLogDelivery.buildDeliveryDestinationArn({
        imsOrgId: IMS_ORG,
        adobeAccountId: '111122223333',
      });
      expect(arn).to.equal(DEST_ARN);
    });

    it('rejects a non-12-digit Adobe account id', () => {
      expect(() => cdnLogDelivery.buildDeliveryDestinationArn({
        imsOrgId: IMS_ORG,
        adobeAccountId: '123',
      })).to.throw('adobeAccountId must be a 12-digit AWS account ID');
    });

    it('rejects a missing imsOrgId', () => {
      expect(() => cdnLogDelivery.buildDeliveryDestinationArn({
        adobeAccountId: '111122223333',
      })).to.throw('imsOrgId is required');
    });
  });

  describe('buildDeliverySourceName', () => {
    it('uses the cloudfront prefix by default', () => {
      expect(cdnLogDelivery.buildDeliverySourceName({ imsOrgId: IMS_ORG, resourceId: DIST }))
        .to.equal(`llmo-cf-${SAFE_ORG}-${DIST}`);
    });

    it('throws on an unsupported provider', () => {
      expect(() => cdnLogDelivery.buildDeliverySourceName({
        provider: 'fastly',
        imsOrgId: IMS_ORG,
        resourceId: DIST,
      })).to.throw('Unsupported CDN provider: fastly');
    });
  });

  describe('createCdnLogDelivery', () => {
    const base = {
      resourceId: DIST,
      accountId: ACCOUNT,
      imsOrgId: IMS_ORG,
      deliveryDestinationArn: DEST_ARN,
    };

    it('creates source + delivery when none exists', async () => {
      const notFound = new Error('not found');
      notFound.name = 'ResourceNotFoundException';
      logsSendStub.onCall(0).rejects(notFound); // GetDeliverySource
      logsSendStub.onCall(1).resolves({}); // PutDeliverySource
      logsSendStub.onCall(2).resolves({ delivery: { id: 'del-1' } }); // CreateDelivery

      const result = await cdnLogDelivery.createCdnLogDelivery(CREDS, base);

      expect(result).to.deep.equal({
        created: true,
        alreadyExisted: false,
        deliverySourceName: `llmo-cf-${SAFE_ORG}-${DIST}`,
        deliveryId: 'del-1',
      });
      const put = logsSendStub.getCall(1).args[0];
      expect(put.commandName).to.equal('PutDeliverySource');
      expect(put.input.resourceArn).to.equal(`arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST}`);
      expect(put.input.logType).to.equal('ACCESS_LOGS');
      const create = logsSendStub.getCall(2).args[0];
      expect(create.input.deliveryDestinationArn).to.equal(DEST_ARN);
      expect(create.input.s3DeliveryConfiguration).to.deep.equal({ suffixPath: '/{yyyy}/{MM}/{dd}/{HH}' });
      expect(create.input.recordFields).to.include('x-host-header');
    });

    it('is a no-op when a delivery already exists', async () => {
      logsSendStub.onCall(0).resolves({ deliverySource: {} }); // GetDeliverySource → exists
      logsSendStub.onCall(1).resolves({
        deliveries: [{ id: 'del-existing', deliverySourceName: `llmo-cf-${SAFE_ORG}-${DIST}` }],
      }); // DescribeDeliveries

      const result = await cdnLogDelivery.createCdnLogDelivery(CREDS, base);

      expect(result).to.deep.equal({
        created: false,
        alreadyExisted: true,
        deliverySourceName: `llmo-cf-${SAFE_ORG}-${DIST}`,
        deliveryId: 'del-existing',
      });
      expect(logsSendStub.callCount).to.equal(2); // no Put/Create
    });

    it('creates the delivery when the source exists but no delivery is linked', async () => {
      logsSendStub.onCall(0).resolves({ deliverySource: {} }); // GetDeliverySource → exists
      logsSendStub.onCall(1).resolves({ deliveries: [] }); // DescribeDeliveries → none
      logsSendStub.onCall(2).resolves({}); // PutDeliverySource (upsert)
      logsSendStub.onCall(3).resolves({ delivery: { id: 'del-2' } }); // CreateDelivery

      const result = await cdnLogDelivery.createCdnLogDelivery(CREDS, base);
      expect(result.created).to.equal(true);
      expect(result.deliveryId).to.equal('del-2');
    });

    it('rethrows a non-NotFound error from GetDeliverySource', async () => {
      logsSendStub.onCall(0).rejects(new Error('AccessDenied'));
      await expect(cdnLogDelivery.createCdnLogDelivery(CREDS, base))
        .to.be.rejectedWith('AccessDenied');
    });

    it('rejects an unsupported provider', async () => {
      await expect(cdnLogDelivery.createCdnLogDelivery(CREDS, { ...base, provider: 'akamai' }))
        .to.be.rejectedWith('Unsupported CDN provider: akamai');
    });

    it('rejects a missing resourceId', async () => {
      await expect(cdnLogDelivery.createCdnLogDelivery(CREDS, { ...base, resourceId: '' }))
        .to.be.rejectedWith('resourceId is required');
    });

    it('rejects a non-12-digit account id', async () => {
      await expect(cdnLogDelivery.createCdnLogDelivery(CREDS, { ...base, accountId: '1' }))
        .to.be.rejectedWith('accountId must be a 12-digit AWS account ID');
    });
  });
});
