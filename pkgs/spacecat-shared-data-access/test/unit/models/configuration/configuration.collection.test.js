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

import Configuration from '../../../../src/models/configuration/configuration.model.js';

import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('ConfigurationCollection', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockLogger;
  let model;
  let schema;

  const mockRecord = {
    configurationId: '2e6d24e8-3a1f-4c2c-9f80-696a177ff699',
    queues: {
      someQueue: {},
    },
    jobs: [],
    version: 1,
  };

  beforeEach(() => {
    ({
      mockElectroService,
      mockEntityRegistry,
      mockLogger,
      collection: instance,
      model,
      schema,
    } = createElectroMocks(Configuration, mockRecord));
  });

  describe('constructor', () => {
    it('initializes the ConfigurationCollection instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.electroService).to.equal(mockElectroService);
      expect(instance.entityRegistry).to.equal(mockEntityRegistry);
      expect(instance.schema).to.equal(schema);
      expect(instance.log).to.equal(mockLogger);

      expect(model).to.be.an('object');
    });
  });

  describe('create', () => {
    it('creates a new configuration as first version', async () => {
      instance.findLatest = stub().resolves(null);

      const result = await instance.create(mockRecord);

      expect(result).to.be.an('object');
      expect(result.getId()).to.equal(mockRecord.configurationId);
    });

    it('creates a new configuration as a new version', async () => {
      const latestConfiguration = {
        getId: () => 's12345',
        getVersion: () => 1,
      };

      instance.findLatest = stub().resolves(latestConfiguration);
      mockRecord.version = 2;

      const result = await instance.create(mockRecord);

      expect(result).to.be.an('object');
      expect(result.getId()).to.equal(mockRecord.configurationId);
      expect(result.getVersion()).to.equal(2);
    });
  });

  describe('findByVersion', () => {
    it('finds configuration by version', async () => {
      const mockResult = { configurationId: 's12345' };

      instance.findByAll = stub().resolves(mockResult);

      const result = await instance.findByVersion(3);

      expect(result).to.deep.equal(mockResult);
      expect(instance.findByAll).to.have.been.calledWithExactly({ versionString: '0000000003' });
    });
  });

  describe('findLatest', () => {
    it('returns the latest configuration', async () => {
      const mockResult = { configurationId: 's12345' };

      instance.findByAll = stub().resolves(mockResult);

      const result = await instance.findLatest();

      expect(result).to.deep.equal(mockResult);
      expect(instance.findByAll).to.have.been.calledWithExactly({}, { order: 'desc' });
    });
  });
});
