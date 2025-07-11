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
  parseCsvToJson,
  copyOneNewestCsvToCache,
} from '../../../src/controllers/paid/caching-helper.js';

use(chaiAsPromised);
use(sinonChai);

describe('Paid TrafficController caching-helper', () => {
  describe('parseCsvToJson', () => {
    it('parses valid CSV correctly', async () => {
      const csv = 'id,name\n1,Alice\n2,Bob';
      const result = await parseCsvToJson(csv);
      expect(result).to.deep.equal([
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ]);
    });

    it('rejects on parse error', async () => {
      const invalidCsv = '"bad,unclosed';
      try {
        await parseCsvToJson(invalidCsv);
        throw new Error('Expected to fail');
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
      }
    });
  });

  describe('copyOneNewestCsvToCache', () => {
    let s3Mock;
    let log;

    beforeEach(() => {
      s3Mock = { send: sinon.stub() };
      log = { error: sinon.spy(), info: sinon.spy() };
    });

    it('keeps latest when next file is older', async () => {
      const listResponse = {
        Contents: [
          { Key: 'latest.csv', LastModified: new Date('2025-01-01') },
          { Key: 'older.csv', LastModified: new Date('2024-01-01') },
        ],
      };

      s3Mock = { send: sinon.stub().resolves(listResponse) };

      const result = await copyOneNewestCsvToCache(
        s3Mock,
        's3://bucket/output',
        's3://cache-bucket/key.csv',
        log,
      );

      expect(result).to.be.true;

      const copyCall = s3Mock.send.getCall(1).args[0];
      expect(copyCall.input.CopySource).to.equal('bucket/latest.csv');
    });

    it('copies the most recent CSV file to cache', async () => {
      const listResponse = {
        Contents: [
          { Key: 'old.csv', LastModified: new Date('2024-01-01') },
          { Key: 'new.csv', LastModified: new Date('2025-01-01') },
          { Key: 'notcsv.txt', LastModified: new Date('2026-01-01') },
        ],
      };
      const expectedCopySource = 'bucket/new.csv';

      s3Mock.send
        .onFirstCall().resolves(listResponse)
        .onSecondCall().resolves(); // for copy

      const result = await copyOneNewestCsvToCache(
        s3Mock,
        's3://bucket/output/path',
        's3://cache-bucket/cache/key.csv',
        log,
      );

      expect(result).to.be.true;
      const copyParams = s3Mock.send.getCall(1).args[0].input;
      expect(copyParams).to.include({
        Bucket: 'cache-bucket',
        Key: 'cache/key.csv',
        CopySource: expectedCopySource,
        ContentType: 'text/csv',
      });
    });

    it('returns false and logs error if no CSV found', async () => {
      s3Mock.send.resolves({ Contents: [] });

      const result = await copyOneNewestCsvToCache(
        s3Mock,
        's3://bucket/output/',
        's3://cache-bucket/key.csv',
        log,
      );

      expect(result).to.be.false;
      expect(log.error.calledOnce).to.be.true;
      expect(log.error.firstCall.args[0]).to.match(/No CSV result found/);
    });

    it('handles unexpected exceptions and logs them', async () => {
      s3Mock.send.throws(new Error('Something broke'));

      const result = await copyOneNewestCsvToCache(
        s3Mock,
        's3://bucket/output/',
        's3://cache-bucket/key.csv',
        log,
      );

      expect(result).to.be.false;
      expect(log.error.calledOnce).to.be.true;
      expect(log.error.firstCall.args[0]).to.include('Something broke');
    });
  });
});
