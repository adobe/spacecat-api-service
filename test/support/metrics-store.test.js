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

import chai from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getStoredMetrics } from '../../src/support/metrics-store.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);
const { expect } = chai;

describe('Metrics Store', () => {
  let s3Client;
  let config;
  let context;

  beforeEach(() => {
    s3Client = {
      send: sinon.stub(),
    };
    config = {
      siteId: 'testSite',
      source: 'testSource',
      metric: 'testMetric',
    };
    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      env: {
        S3_BUCKET_NAME: 'testBucket',
      },
    };
  });

  describe('getStoredMetrics', () => {
    it('should return metrics when retrieval is successful', async () => {
      const expectedMetrics = [{
        siteId: '123',
        source: 'ahrefs',
        time: '2023-03-12T00:00:00Z',
        metric: 'organic-traffic',
        value: 100,
      }, {
        siteId: '123',
        source: 'ahrefs',
        time: '2023-03-13T00:00:00Z',
        metric: 'organic-traffic',
        value: 200,
      }];
      s3Client.send.resolves({
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify(expectedMetrics)),
        },
      });

      const metrics = await getStoredMetrics(s3Client, config, context);

      expect(metrics).to.deep.equal(expectedMetrics);
      expect(s3Client.send.calledWith(sinon.match.instanceOf(GetObjectCommand))).to.be.true;
      expect(s3Client.send.calledWith(sinon.match.hasNested('input.Bucket', context.env.S3_BUCKET_NAME))).to.be.true;
      expect(s3Client.send.calledWith(sinon.match.hasNested('input.Key', 'metrics/testSite/testSource/testMetric.json'))).to.be.true;
      expect(context.log.info).to.have.been.calledWith('Successfully retrieved 2 metrics from metrics/testSite/testSource/testMetric.json');
    });

    it('should return empty array when retrieval fails', async () => {
      s3Client.send.rejects(new Error('Test error'));

      const metrics = await getStoredMetrics(s3Client, config, context);

      expect(metrics).to.deep.equal([]);
      expect(context.log.error).to.have.been.calledWith('Failed to retrieve metrics from metrics/testSite/testSource/testMetric.json, error: Test error');
    });
  });
});
