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

    it('throws when the org id produces an empty or non-alphanumeric-start AWS name segment', () => {
      // '@AdobeOrg' alone strips to '' → falsy → throws
      expect(() => mod.buildDeliverySourceName({ imsOrgId: '@AdobeOrg', resourceId: 'E2X' }))
        .to.throw("IMS org ID '@AdobeOrg' produces an invalid AWS resource name segment");
    });

    it('hashes-truncates to <=60 chars (deterministically) for long ids', () => {
      const imsOrgId = `${'A'.repeat(40)}@AdobeOrg`;
      const resourceId = 'E'.repeat(40);
      const name1 = mod.buildDeliverySourceName({ imsOrgId, resourceId });
      const name2 = mod.buildDeliverySourceName({ imsOrgId, resourceId });

      expect(name1.length).to.equal(60);
      expect(name1).to.equal(name2); // deterministic — required for idempotency
      expect(name1).to.match(/^llmo-cf-/);
      // Different inputs must not collide on the truncated name.
      const other = mod.buildDeliverySourceName({ imsOrgId, resourceId: 'F'.repeat(40) });
      expect(other).to.not.equal(name1);
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
      let putCmd;
      let createCmd;
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf());
        }
        if (cmd.type === 'put') {
          putCmd = cmd;
          return Promise.resolve({});
        }
        if (cmd.type === 'create') {
          createCmd = cmd;
          return Promise.resolve({ delivery: { id: 'del-new' } });
        }
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(true);
      expect(result.alreadyExisted).to.equal(false);
      expect(result.deliveryId).to.equal('del-new');
      expect(result.deliverySourceName).to.equal('llmo-cf-abc123-E2EXAMPLE123');

      // Assert the exact inputs sent to each AWS command.
      expect(putCmd.input.name).to.equal('llmo-cf-abc123-E2EXAMPLE123');
      expect(putCmd.input.resourceArn).to.equal(
        `arn:aws:cloudfront::${baseParams.accountId}:distribution/${baseParams.resourceId}`,
      );
      expect(putCmd.input.logType).to.equal('ACCESS_LOGS');
      expect(createCmd.input.deliverySourceName).to.equal('llmo-cf-abc123-E2EXAMPLE123');
      expect(createCmd.input.deliveryDestinationArn).to.equal(baseParams.deliveryDestinationArn);
      expect(createCmd.input.s3DeliveryConfiguration).to.deep.equal({ suffixPath: '/{yyyy}/{MM}/{dd}/{HH}' });
      expect(createCmd.input.recordFields).to.include('cs-uri-stem');
    });

    it('is idempotent when a delivery already exists (paginated)', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'describe') {
          // First page: no match + nextToken; second page: the match. Match requires both
          // deliverySourceName AND deliveryDestinationArn to guard against stale destinations.
          if (!cmd.input.nextToken) {
            return Promise.resolve({ deliveries: [{ deliverySourceName: 'other' }], nextToken: 'p2' });
          }
          return Promise.resolve({
            deliveries: [{
              deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123',
              deliveryDestinationArn: baseParams.deliveryDestinationArn,
              id: 'del-existing',
            }],
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
            deliveries: [{
              deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123',
              deliveryDestinationArn: baseParams.deliveryDestinationArn,
              id: 'del-raced',
            }],
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

    it('recovers when the source already exists but no delivery is found (partial state)', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.resolve({}); // source already exists → skip PutDeliverySource
        }
        if (cmd.type === 'describe') {
          // No existing delivery found for this source+destination pair.
          return Promise.resolve({ deliveries: [] });
        }
        if (cmd.type === 'create') {
          return Promise.resolve({ delivery: { id: 'del-recovered' } });
        }
        return Promise.resolve({});
      });

      const result = await mod.createCdnLogDelivery(creds, baseParams);

      expect(result.created).to.equal(true);
      expect(result.alreadyExisted).to.equal(false);
      expect(result.deliveryId).to.equal('del-recovered');
    });

    it('on a conflict, returns alreadyExisted with undefined id when the raced delivery is not found', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source absent → reach PutDeliverySource + CreateDelivery
        }
        if (cmd.type === 'create') {
          return Promise.reject(Object.assign(new Error('exists'), { name: 'ConflictException' }));
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

    it('throws DeliverySourceConflict when PutDeliverySource rejects with ConflictException', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source absent → reach PutDeliverySource
        }
        if (cmd.type === 'put') {
          // Distribution already registered to a different delivery source.
          return Promise.reject(Object.assign(new Error('conflict'), { name: 'ConflictException' }));
        }
        return Promise.resolve({});
      });

      const err = await mod.createCdnLogDelivery(creds, baseParams).catch((e) => e);
      expect(err.name).to.equal('DeliverySourceConflict');
      expect(err.message).to.include('different delivery source');
    });

    it('rethrows a non-conflict error from PutDeliverySource', async () => {
      sendStub.callsFake((cmd) => {
        if (cmd.type === 'get') {
          return Promise.reject(rnf()); // source absent → reach PutDeliverySource
        }
        if (cmd.type === 'put') {
          return Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
        }
        return Promise.resolve({});
      });

      await expect(mod.createCdnLogDelivery(creds, baseParams))
        .to.be.rejectedWith('throttled');
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
