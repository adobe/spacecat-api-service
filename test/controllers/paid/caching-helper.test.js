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
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { describe } from 'mocha';
import {
  fileExists,
  parseS3Uri,
  getS3CachedResult,
  addResultJsonToCache,
  getSignedUrlWithRetries,
} from '../../../src/controllers/paid/caching-helper.js';

use(chaiAsPromised);
use(sinonChai);

describe('Paid TrafficController caching-helper', () => {
  let sandbox;
  let mockS3;
  let mockLog;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockS3 = {
      s3Client: { send: sandbox.stub() },
      getSignedUrl: sandbox.stub().resolves('fakeSignedUrl'),
    };
    mockLog = {
      info: sandbox.stub(),
      error: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('parseS3Uri', () => {
    it('parses s3 uri with prefix', () => {
      const result = parseS3Uri('s3://my-bucket/some/path/file.json');
      expect(result).to.deep.equal({ bucket: 'my-bucket', prefix: 'some/path/file.json' });
    });
    it('parses s3 uri with only bucket', () => {
      const result = parseS3Uri('s3://my-bucket');
      expect(result).to.deep.equal({ bucket: 'my-bucket', prefix: '' });
    });
  });

  describe('fileExists', () => {
    it('returns true if HeadObjectCommand succeeds', async () => {
      mockS3.s3Client.send.resolves();
      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog);
      expect(result).to.be.true;
      expect(mockLog.info).to.have.been.calledWithMatch('Checking if cached result exists');
    });
    it('returns false if HeadObjectCommand throws NotFound', async () => {
      const err = new Error('not found');
      err.name = 'NotFound';
      mockS3.s3Client.send.rejects(err);
      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog);
      expect(result).to.be.false;
    });
    it('logs and returns false on other errors', async () => {
      const err = new Error('fail');
      err.name = 'OtherError';
      mockS3.s3Client.send.rejects(err);
      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog);
      expect(result).to.be.false;
      expect(mockLog.error).to.have.been.calledWithMatch('Unexpected error');
    });
  });

  describe('getS3CachedResult', () => {
    it('returns presigned url if getSignedUrl succeeds', async () => {
      mockS3.getSignedUrl.resolves('https://signed-url');
      const url = await getS3CachedResult(mockS3, 's3://bucket/key.json', mockLog);
      expect(url).to.equal('https://signed-url');
    });
    it('returns null if error is NoSuchKey', async () => {
      mockS3.getSignedUrl.rejects(Object.assign(new Error('no such key'), { name: 'NoSuchKey' }));
      const url = await getS3CachedResult(mockS3, 's3://bucket/key.json', mockLog);
      expect(url).to.be.null;
    });
    it('logs and returns null on other errors', async () => {
      mockS3.getSignedUrl.rejects(Object.assign(new Error('fail'), { name: 'OtherError' }));
      const url = await getS3CachedResult(mockS3, 's3://bucket/key.json', mockLog);
      expect(url).to.be.null;
      expect(mockLog.error).to.have.been.calledWithMatch('Unexpected exception');
    });
  });

  describe('addResultJsonToCache', () => {
    it('returns true if PutObjectCommand succeeds', async () => {
      mockS3.s3Client.send.resolves();
      const result = await addResultJsonToCache(mockS3, 's3://bucket/key.json', { foo: 'bar' }, mockLog);
      expect(result).to.be.true;
    });
    it('logs and returns false if PutObjectCommand fails', async () => {
      mockS3.s3Client.send.rejects(new Error('fail'));
      const result = await addResultJsonToCache(mockS3, 's3://bucket/key.json', { foo: 'bar' }, mockLog);
      expect(result).to.be.false;
      expect(mockLog.error).to.have.been.calledWithMatch('Failed to add result json to cache');
    });
  });

  describe('fileExists retries', () => {
    it('retries on ServiceUnavailable error and eventually succeeds', async () => {
      const serviceUnavailableError = new Error('Service unavailable');
      serviceUnavailableError.name = 'ServiceUnavailable';

      mockS3.s3Client.send
        .onFirstCall().rejects(serviceUnavailableError)
        .onSecondCall().resolves();

      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog, 2, 10);
      expect(result).to.be.true;
      expect(mockS3.s3Client.send).to.have.been.calledTwice;
    });

    it('retries on 503 error and eventually fails after max attempts', async () => {
      const error503 = new Error('Service unavailable');
      error503.$metadata = { httpStatusCode: 503 };

      mockS3.s3Client.send.rejects(error503);

      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog, 2, 10);
      expect(result).to.be.false;
      expect(mockS3.s3Client.send).to.have.been.calledTwice;
      expect(mockLog.error).to.have.been.calledWithMatch('Unexpected error when checking cache (attempt 2)');
    });

    it('exhausts all retry attempts and returns false', async () => {
      const retryableError = new Error('Service unavailable');
      retryableError.name = 'ServiceUnavailable';

      mockS3.s3Client.send.rejects(retryableError);

      const result = await fileExists(mockS3, 's3://bucket/key.json', mockLog, 3, 10);
      expect(result).to.be.false;
      expect(mockS3.s3Client.send).to.have.been.calledThrice;
    });
  });

  describe('getSignedUrlWithRetries', () => {
    it('returns signed url when file exists', async () => {
      mockS3.s3Client.send.resolves();
      mockS3.getSignedUrl.resolves('https://signed-url');

      const result = await getSignedUrlWithRetries(mockS3, 's3://bucket/key.json', mockLog, 1);
      expect(result).to.equal('https://signed-url');
    });

    it('returns null when file does not exist', async () => {
      const notFoundError = new Error('not found');
      notFoundError.name = 'NotFound';
      mockS3.s3Client.send.rejects(notFoundError);

      const result = await getSignedUrlWithRetries(mockS3, 's3://bucket/key.json', mockLog, 1);
      expect(result).to.be.null;
    });
  });
});
