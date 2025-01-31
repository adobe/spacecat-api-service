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

import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { stub } from 'sinon';
import sinonChai from 'sinon-chai';

import ImportJob from '../../../../src/models/import-job/import-job.model.js';

import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('ImportJobCollection', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockLogger;
  let model;
  let schema;

  const mockRecord = {
    importJobId: 's12345',
  };

  beforeEach(() => {
    ({
      mockElectroService,
      mockEntityRegistry,
      mockLogger,
      collection: instance,
      model,
      schema,
    } = createElectroMocks(ImportJob, mockRecord));
  });

  describe('constructor', () => {
    it('initializes the ImportJobCollection instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.electroService).to.equal(mockElectroService);
      expect(instance.entityRegistry).to.equal(mockEntityRegistry);
      expect(instance.schema).to.equal(schema);
      expect(instance.log).to.equal(mockLogger);

      expect(model).to.be.an('object');
    });
  });

  describe('allByDateRange', () => {
    it('throws an error if the startDate is not a valid iso date', async () => {
      await expect(instance.allByDateRange()).to.be.rejectedWith('Invalid start date: undefined');
    });

    it('throws an error if the endDate is not a valid iso date', async () => {
      const startIsoDate = '2024-12-06T08:35:24.125Z';
      await expect(instance.allByDateRange(startIsoDate)).to.be.rejectedWith('Invalid end date: undefined');
    });

    it('returns all import jobs by date range', async () => {
      const startIsoDate = '2024-12-06T08:35:24.125Z';
      const endIsoDate = '2024-12-07T08:35:24.125Z';

      const mockResult = [{ importJobId: 's12345' }];

      instance.all = stub().resolves(mockResult);

      const result = await instance.allByDateRange(startIsoDate, endIsoDate);

      expect(result).to.deep.equal(mockResult);
      expect(instance.all).to.have.been.calledWithExactly({}, {
        between:
          {
            attribute: 'startedAt',
            start: '2024-12-06T08:35:24.125Z',
            end: '2024-12-07T08:35:24.125Z',
          },
      });
    });
  });
});
