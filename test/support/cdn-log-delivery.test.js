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
  let mod;
  let sendStub;

  // Tag each AWS command with a `type` so a sent command can be identified without instanceof
  // (avoids defining multiple marker classes). `new Cmd(input)` returns the tagged object.
  const makeCmd = (type) => function Cmd(input) {
    return { type, input };
  };
  const GetDeliverySourceCommand = makeCmd('get');
  const DescribeDeliveriesCommand = makeCmd('describe');
  const PutDeliverySourceCommand = makeCmd('put');
  const CreateDeliveryCommand = makeCmd('create');

  beforeEach(async () => {
    sendStub = sinon.stub();
    mod = await esmock('../../src/support/cdn-log-delivery.js', {
      '@aws-sdk/client-cloudwatch-logs': {
        CloudWatchLogsClient: function CloudWatchLogsClient() {
          this.send = (cmd) => sendStub(cmd);
        },
        GetDeliverySourceCommand,
        DescribeDeliveriesCommand,
        PutDeliverySourceCommand,
        CreateDeliveryCommand,
      },
    });
  });

  afterEach(() => sinon.restore());

  describe('toSafeAwsName', () => {
    it('strips @AdobeOrg, removes @, lowercases', () => {
      expect(mod.toSafeAwsName('ABC123@AdobeOrg')).to.equal('abc123');
      expect(mod.toSafeAwsName('Foo@Bar@AdobeOrg')).to.equal('foobar');
    });
  });

  describe('buildDeliveryDestinationArn', () => {
    it('builds an org-scoped destination ARN', () => {
      const arn = mod.buildDeliveryDestinationArn({
        imsOrgId: 'ABC123@AdobeOrg',
        adobeAccountId: '111122223333',
      });
      expect(arn).to.equal(
        'arn:aws:logs:us-east-1:111122223333:delivery-destination:cdn-logs-abc123',
      );
    });

    it('throws when imsOrgId is missing', () => {
      expect(() => mod.buildDeliveryDestinationArn({ adobeAccountId: '111122223333' }))
        .to.throw('imsOrgId is required');
    });

    it('throws when adobeAccountId is not 12 digits', () => {
      expect(() => mod.buildDeliveryDestinationArn({ imsOrgId: 'x@AdobeOrg', adobeAccountId: '123' }))
        .to.throw('12-digit');
    });
  });

  describe('buildDeliverySourceName', () => {
    it('scopes the name by provider + org + resource', () => {
      expect(mod.buildDeliverySourceName({ imsOrgId: 'ABC123@AdobeOrg', resourceId: 'E2X' }))
        .to.equal('llmo-cf-abc123-E2X');
    });

    it('throws for an unsupported provider', () => {
      expect(() => mod.buildDeliverySourceName({ provider: 'nope', imsOrgId: 'x', resourceId: 'y' }))
        .to.throw('Unsupported CDN provider');
    });
  });

  describe('createCdnLogDelivery', () => {
    const creds = { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' };
    const baseParams = {
      provider: 'cloudfront',
      resourceId: 'E2EXAMPLE123',
      accountId: '120569600543',
      imsOrgId: 'ABC123@AdobeOrg',
      deliveryDestinationArn: 'arn:aws:logs:us-east-1:111122223333:delivery-destination:cdn-logs-abc123',
    };

    const rnf = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

    it('creates source + delivery when none exists', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf());
        }
        if (cmd.type === 'create') {
          return Promise.resolve({ delivery: { id: 'del-new' } });
        }
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(true);
      expect(result.alreadyExisted).to.equal(false);
      expect(result.deliveryId).to.equal('del-new');
      expect(result.deliverySourceName).to.equal('llmo-cf-abc123-E2EXAMPLE123');
    });

    it('is idempotent when a delivery already exists (paginated)', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'describe') {
          // First page: no match + nextToken; second page: the match.
          if (!cmd.input.nextToken) {
            return Promise.resolve({ deliveries: [{ deliverySourceName: 'other' }], nextToken: 'p2' });
          }
          return Promise.resolve({
            deliveries: [{ deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123', id: 'del-existing' }],
          });
        }
        // GetDeliverySource resolves (source exists) → triggers the paginated describe lookup.
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(false);
      expect(result.alreadyExisted).to.equal(true);
      expect(result.deliveryId).to.equal('del-existing');
    });

    it('treats a CreateDelivery ConflictException as already-existed (TOCTOU race)', async () => {
      let describeCalls = 0;
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source does not exist yet → no early return
        }
        if (cmd.type === 'create') {
          // A concurrent caller created the delivery between our check and this call.
          return Promise.reject(Object.assign(new Error('exists'), { name: 'ConflictException' }));
        }
        if (cmd.type === 'describe') {
          describeCalls += 1;
          return Promise.resolve({
            deliveries: [{ deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123', id: 'del-raced' }],
          });
        }
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(false);
      expect(result.alreadyExisted).to.equal(true);
      expect(result.deliveryId).to.equal('del-raced');
      expect(describeCalls).to.equal(1); // looked up the winner's delivery id after the conflict
    });

    it('on a conflict, returns alreadyExisted with undefined id when the raced delivery is not found', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source absent → reach PutDeliverySource + CreateDelivery
        }
        if (cmd.type === 'create') {
          return Promise.reject(Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' }));
        }
        if (cmd.type === 'describe') {
          // Paginate through pages with no matching deliverySourceName, then exhaust nextToken
          // → findExistingDelivery returns undefined (its loop fall-through).
          if (!cmd.input.nextToken) {
            return Promise.resolve({ deliveries: [{ deliverySourceName: 'other' }], nextToken: 'p2' });
          }
          return Promise.resolve({ deliveries: [{ deliverySourceName: 'another' }] });
        }
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(false);
      expect(result.alreadyExisted).to.equal(true);
      expect(result.deliveryId).to.equal(undefined);
    });

    it('rethrows a non-conflict error from CreateDelivery', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source absent → reach CreateDelivery
        }
        if (cmd.type === 'create') {
          return Promise.reject(Object.assign(new Error('bad input'), { name: 'ValidationException' }));
        }
        return Promise.resolve({});
      });

      await expect(mod.createCdnLogDelivery(creds, baseParams))
        .to.be.rejectedWith('bad input');
    });

    it('rethrows a non-ResourceNotFound error from GetDeliverySource', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(Object.assign(new Error('boom'), { name: 'AccessDeniedException' }));
        }
        return Promise.resolve({});
      });

      await expect(mod.createCdnLogDelivery(creds, baseParams))
        .to.be.rejectedWith('boom');
    });

    it('throws when resourceId is missing', async () => {
      await expect(mod.createCdnLogDelivery(creds, { ...baseParams, resourceId: '' }))
        .to.be.rejectedWith('resourceId is required');
    });

    it('throws when accountId is not 12 digits', async () => {
      await expect(mod.createCdnLogDelivery(creds, { ...baseParams, accountId: '123' }))
        .to.be.rejectedWith('12-digit');
    });

    it('throws when imsOrgId is missing', async () => {
      await expect(mod.createCdnLogDelivery(creds, { ...baseParams, imsOrgId: '' }))
        .to.be.rejectedWith('imsOrgId is required');
    });

    it('throws when deliveryDestinationArn is missing', async () => {
      await expect(mod.createCdnLogDelivery(creds, { ...baseParams, deliveryDestinationArn: '' }))
        .to.be.rejectedWith('deliveryDestinationArn is required');
    });
  });
});
