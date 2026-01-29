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

/* eslint-env mocha */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  getCustomerConfigV2FromS3,
  saveCustomerConfigV2ToS3,
  customerConfigV2Exists,
} from '../../src/support/customer-config-v2-s3.js';

use(chaiAsPromised);
use(sinonChai);

describe('Customer Config V2 S3', () => {
  let s3ClientStub;
  const s3Bucket = 'test-bucket';
  const organizationId = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const mockConfig = {
    customer: {
      customerName: 'Adobe',
      brands: [],
    },
  };

  beforeEach(() => {
    s3ClientStub = {
      send: sinon.stub(),
    };
  });

  describe('getCustomerConfigV2FromS3', () => {
    it('fetches config from S3 successfully', async () => {
      const mockBody = {
        transformToString: sinon.stub().resolves(JSON.stringify(mockConfig)),
      };

      s3ClientStub.send.resolves({ Body: mockBody });

      const result = await getCustomerConfigV2FromS3(organizationId, s3ClientStub, s3Bucket);

      expect(result).to.deep.equal(mockConfig);
      expect(s3ClientStub.send).to.have.been.calledOnce;

      const command = s3ClientStub.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal(s3Bucket);
      expect(command.input.Key).to.equal(`customer-config-v2/${organizationId}/config.json`);
    });

    it('returns null if config does not exist', async () => {
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      s3ClientStub.send.rejects(error);

      const result = await getCustomerConfigV2FromS3(organizationId, s3ClientStub, s3Bucket);

      expect(result).to.be.null;
    });

    it('returns null if 404 error', async () => {
      const error = new Error('Not found');
      error.$metadata = { httpStatusCode: 404 };
      s3ClientStub.send.rejects(error);

      const result = await getCustomerConfigV2FromS3(organizationId, s3ClientStub, s3Bucket);

      expect(result).to.be.null;
    });

    it('throws error for other S3 errors', async () => {
      s3ClientStub.send.rejects(new Error('S3 error'));

      await expect(
        getCustomerConfigV2FromS3(organizationId, s3ClientStub, s3Bucket),
      ).to.be.rejectedWith('S3 error');
    });

    it('throws error if Organization ID is missing', async () => {
      await expect(
        getCustomerConfigV2FromS3('', s3ClientStub, s3Bucket),
      ).to.be.rejectedWith('Organization ID is required');
    });

    it('throws error if S3 client is missing', async () => {
      await expect(
        getCustomerConfigV2FromS3(organizationId, null, s3Bucket),
      ).to.be.rejectedWith('S3 client and bucket are required');
    });

    it('throws error if bucket is missing', async () => {
      await expect(
        getCustomerConfigV2FromS3(organizationId, s3ClientStub, ''),
      ).to.be.rejectedWith('S3 client and bucket are required');
    });
  });

  describe('saveCustomerConfigV2ToS3', () => {
    it('saves config to S3 successfully', async () => {
      s3ClientStub.send.resolves({});

      await saveCustomerConfigV2ToS3(organizationId, mockConfig, s3ClientStub, s3Bucket);

      expect(s3ClientStub.send).to.have.been.calledOnce;

      const command = s3ClientStub.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal(s3Bucket);
      expect(command.input.Key).to.equal(`customer-config-v2/${organizationId}/config.json`);
      expect(command.input.ContentType).to.equal('application/json');

      const savedBody = JSON.parse(command.input.Body);
      expect(savedBody).to.deep.equal(mockConfig);
    });

    it('throws error if Organization ID is missing', async () => {
      await expect(
        saveCustomerConfigV2ToS3('', mockConfig, s3ClientStub, s3Bucket),
      ).to.be.rejectedWith('Organization ID is required');
    });

    it('throws error if config is missing', async () => {
      await expect(
        saveCustomerConfigV2ToS3(organizationId, null, s3ClientStub, s3Bucket),
      ).to.be.rejectedWith('Config is required');
    });

    it('throws error if S3 client is missing', async () => {
      await expect(
        saveCustomerConfigV2ToS3(organizationId, mockConfig, null, s3Bucket),
      ).to.be.rejectedWith('S3 client and bucket are required');
    });

    it('throws error if bucket is missing', async () => {
      await expect(
        saveCustomerConfigV2ToS3(organizationId, mockConfig, s3ClientStub, ''),
      ).to.be.rejectedWith('S3 client and bucket are required');
    });
  });

  describe('customerConfigV2Exists', () => {
    it('returns true if config exists', async () => {
      const mockBody = {
        transformToString: sinon.stub().resolves(JSON.stringify(mockConfig)),
      };
      s3ClientStub.send.resolves({ Body: mockBody });

      const exists = await customerConfigV2Exists(organizationId, s3ClientStub, s3Bucket);

      expect(exists).to.be.true;
    });

    it('returns false if config does not exist', async () => {
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      s3ClientStub.send.rejects(error);

      const exists = await customerConfigV2Exists(organizationId, s3ClientStub, s3Bucket);

      expect(exists).to.be.false;
    });
  });
});
