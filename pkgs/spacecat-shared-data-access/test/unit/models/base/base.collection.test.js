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

// eslint-disable-next-line max-classes-per-file
import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ElectroValidationError } from 'electrodb';
import { spy, stub } from 'sinon';
import sinonChai from 'sinon-chai';

import BaseCollection from '../../../../src/models/base/base.collection.js';
import Schema from '../../../../src/models/base/schema.js';
import BaseModel from '../../../../src/models/base/base.model.js';
import { DataAccessError } from '../../../../src/index.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

const MockModel = class MockEntityModel extends BaseModel { };
const MockCollection = class MockEntityCollection extends BaseCollection { };

const createSchema = (service, indexes) => new Schema(
  MockModel,
  MockCollection,
  {
    serviceName: 'service',
    schemaVersion: 1,
    attributes: {
      someKey: { type: 'string' },
      someOtherKey: { type: 'number' },
    },
    indexes,
    references: [],
    options: { allowRemove: true, allowUpdates: true },
  },
);

const createInstance = (service, registry, indexes, log) => {
  const schema = createSchema(service, indexes);
  return new BaseCollection(
    service,
    registry,
    schema,
    log,
  );
};

describe('BaseCollection', () => {
  let baseCollectionInstance;
  let mockElectroService;
  let mockEntityRegistry;
  let mockIndexes;
  let mockLogger;

  const mockRecord = {
    mockEntityModelId: 'ef39921f-9a02-41db-b491-02c98987d956',
    mockParentEntityModelId: 'some-parent-id',
    data: {
      someKey: 'someValue',
    },
  };

  beforeEach(() => {
    mockIndexes = { primary: {}, all: { index: 'all', indexType: 'all' } };
    mockEntityRegistry = {
      aclCtx: {
        aclEntities: {
          // Exclude the opportunity entity (which is used by these mocks) from ACL checks
          exclude: ['mockEntityModel'],
        },
      },
      getCollection: stub(),
    };

    mockLogger = {
      error: spy(),
      debug: spy(),
      info: spy(),
      warn: spy(),
    };

    mockElectroService = {
      entities: {
        mockEntityModel: {
          create: stub(),
          delete: stub(),
          get: stub(),
          put: stub(),
          query: {
            all: stub().returns({
              between: stub().returns({
                go: () => ({ data: [] }),
              }),
              go: () => ({ data: [] }),
            }),
            bySomeKey: stub(),
            primary: stub(),
          },
          model: {
            entity: 'MockEntityModel',
            indexes: {},
            table: 'data',
            original: {},
            schema: {
              attributes: {},
            },
          },
        },
      },
    };

    baseCollectionInstance = createInstance(
      mockElectroService,
      mockEntityRegistry,
      mockIndexes,
      mockLogger,
    );
  });

  describe('collection methods', () => {
    it('does not create accessors for the primary index', () => {
      mockIndexes = { primary: {} };

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      expect(instance).to.not.have.property('allBy');
      expect(instance).to.not.have.property('findBy');
    });

    it('creates accessors for partition key attributes', () => {
      mockIndexes = {
        bySomeKey: { pk: { facets: ['someKey'] } },
      };

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      expect(instance).to.have.property('allBySomeKey');
      expect(instance).to.have.property('findBySomeKey');
    });

    it('creates accessors for sort key attributes', () => {
      mockIndexes = {
        bySomeKey: { sk: { facets: ['someKey'] } },
      };

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      expect(instance).to.have.property('allBySomeKey');
      expect(instance).to.have.property('findBySomeKey');
    });

    it('creates accessors for partition and sort key attributes', () => {
      mockIndexes = {
        bySomeKey: { index: 'bySomeKey', pk: { facets: ['someKey'] }, sk: { facets: ['someOtherKey'] } },
      };

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      expect(instance).to.have.property('allBySomeKey');
      expect(instance).to.have.property('allBySomeKeyAndSomeOtherKey');
      expect(instance).to.have.property('findBySomeKey');
      expect(instance).to.have.property('findBySomeKeyAndSomeOtherKey');
    });

    it('parses accessor arguments correctly', async () => {
      mockElectroService.entities.mockEntityModel.query.bySomeKey.returns(
        { go: () => Promise.resolve({ data: [] }) },
      );
      mockIndexes = {
        bySomeKey: { index: 'bySomeKey', pk: { facets: ['someKey'] }, sk: { facets: ['someOtherKey'] } },
      };

      mockElectroService.entities.mockEntityModel.model.schema = {
        attributes: {
          someKey: { type: 'string' },
          someOtherKey: { type: 'number' },
        },
      };

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      const someKey = 'someValue';
      const someOtherKey = 1;
      const options = { order: 'desc' };

      await instance.allBySomeKey(someKey);
      await instance.findBySomeKey(someKey);
      await instance.allBySomeKeyAndSomeOtherKey(someKey, someOtherKey);
      await instance.findBySomeKeyAndSomeOtherKey(someKey, someOtherKey);
      await instance.findBySomeKeyAndSomeOtherKey(someKey, someOtherKey, options);

      await expect(instance.allBySomeKey()).to.be.rejectedWith('someKey is required');
      await expect(instance.findBySomeKey()).to.be.rejectedWith('someKey is required');
      await expect(instance.allBySomeKeyAndSomeOtherKey(someKey)).to.be.rejectedWith('someOtherKey is required');
      await expect(instance.allBySomeKeyAndSomeOtherKey(someKey, '1')).to.be.rejectedWith('someOtherKey is required');
      await expect(instance.findBySomeKeyAndSomeOtherKey(someKey)).to.be.rejectedWith('someOtherKey is required');
    });
  });

  describe('findById', () => {
    it('returns the entity if found', async () => {
      const mockFindResult = { data: mockRecord };
      mockElectroService.entities.mockEntityModel.get.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const result = await baseCollectionInstance.findById('ef39921f-9a02-41db-b491-02c98987d956');

      expect(result.record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.get.calledOnce).to.be.true;
    });

    it('returns null if the entity is not found', async () => {
      mockElectroService.entities.mockEntityModel.get.returns(
        { go: () => Promise.resolve(null) },
      );

      const result = await baseCollectionInstance.findById('ef39921f-9a02-41db-b491-02c98987d956');

      expect(result).to.be.null;
      expect(mockElectroService.entities.mockEntityModel.get.calledOnce).to.be.true;
    });
  });

  describe('existsById', () => {
    it('returns true if entity exists', async () => {
      const mockFindResult = { data: mockRecord };
      mockElectroService.entities.mockEntityModel.get.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const result = await baseCollectionInstance.existsById('ef39921f-9a02-41db-b491-02c98987d956');

      expect(result).to.be.true;
      expect(mockElectroService.entities.mockEntityModel.get.calledOnce).to.be.true;
    });

    it('returns false if entity does not exist', async () => {
      mockElectroService.entities.mockEntityModel.get.returns(
        { go: () => Promise.resolve(null) },
      );

      const result = await baseCollectionInstance.existsById('ef39921f-9a02-41db-b491-02c98987d956');

      expect(result).to.be.false;
      expect(mockElectroService.entities.mockEntityModel.get.calledOnce).to.be.true;
    });
  });

  describe('findByIndexKeys', () => {
    it('throws error if keys is not provided', async () => {
      await expect(baseCollectionInstance.findByIndexKeys())
        .to.be.rejectedWith(DataAccessError, 'Failed to query [mockEntityModel]: keys are required');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('throws error if index is not found', async () => {
      await expect(baseCollectionInstance.findByIndexKeys({ someKey: 'someValue' }, { index: 'none' }))
        .to.be.rejectedWith(DataAccessError, 'Failed to query [mockEntityModel]: query proxy [none] not found');
      expect(mockLogger.error).to.have.been.calledOnce;
    });
  });

  describe('create', () => {
    it('throws an error if the record is empty', async () => {
      await expect(baseCollectionInstance.create(null)).to.be.rejectedWith('Failed to create [mockEntityModel]');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('creates a new entity successfully', async () => {
      mockElectroService.entities.mockEntityModel.create.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );

      const result = await baseCollectionInstance.create(mockRecord);
      expect(result.record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.create.calledOnce).to.be.true;
    });

    it('upserts an existing entity successfully', async () => {
      mockElectroService.entities.mockEntityModel.put.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );
      const result = await baseCollectionInstance.create(mockRecord, { upsert: true });
      expect(result.record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.put.calledOnce).to.be.true;
    });

    it('logs an error and throws when creation fails', async () => {
      const error = new Error('Create failed');
      error.fields = [{ field: 'someKey', message: 'Some key is required' }];
      mockElectroService.entities.mockEntityModel.create.returns(
        { go: () => Promise.reject(error) },
      );

      await expect(baseCollectionInstance.create(mockRecord.data)).to.be.rejectedWith(DataAccessError, 'Failed to create');
      expect(mockLogger.error.calledTwice).to.be.true;
    });

    it('calls the on-create handler if provided', async () => {
      mockElectroService.entities.mockEntityModel.create.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );

      const onCreate = stub().resolves();
      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      // eslint-disable-next-line no-underscore-dangle
      instance._onCreate = onCreate;

      await instance.create(mockRecord);

      expect(onCreate).to.have.been.calledOnce;
    });

    it('logs error if onCreate handler fails', async () => {
      const error = new Error('On-create failed');
      mockElectroService.entities.mockEntityModel.create.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );

      const onCreate = stub().rejects(error);
      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      // eslint-disable-next-line no-underscore-dangle
      instance._onCreate = onCreate;

      await instance.create(mockRecord);

      expect(onCreate).to.have.been.calledOnce;
      expect(mockLogger.error).to.have.been.calledOnceWith('On-create handler failed');
    });
  });

  describe('createMany', () => {
    it('throws an error if the items are empty', async () => {
      await expect(baseCollectionInstance.createMany(null))
        .to.be.rejectedWith('Failed to create many [mockEntityModel]: items must be a non-empty array');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('creates multiple entities successfully', async () => {
      const mockRecords = [mockRecord, mockRecord];
      const mockPutResults = {
        type: 'query',
        method: 'batchWrite',
        params: {
          RequestItems: {
            mockEntityModel: [
              { PutRequest: { Item: mockRecord } },
              { PutRequest: { Item: mockRecord } },
            ],
          },
        },
      };
      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.resolve(mockPutResults),
          params: () => ({ Item: { ...mockRecord } }),
        },
      );

      const result = await baseCollectionInstance.createMany(mockRecords);
      expect(result.createdItems).to.be.an('array').that.has.length(2);
      expect(result.createdItems[0].record).to.deep.include(mockRecord);
      expect(result.createdItems[1].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.put.calledThrice).to.be.true;
    });

    it('creates many with a parent entity', async () => {
      const mockRecords = [mockRecord, mockRecord];
      const mockPutResults = {
        type: 'query',
        method: 'batchWrite',
        params: {
          RequestItems: {
            mockEntityModel: [
              { PutRequest: { Item: mockRecord } },
              { PutRequest: { Item: mockRecord } },
            ],
          },
        },
      };
      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.resolve(mockPutResults),
          params: () => ({ Item: { ...mockRecord } }),
        },
      );

      const parent = {
        record: { mockParentEntityModelId: mockRecord.mockParentEntityModelId },
        entityName: 'mockParentEntityModel',
        entity: { model: { name: 'mockParentEntityModel' } },
        schema: { getModelName: () => 'MockParentEntityModel' },
      };

      const result = await baseCollectionInstance.createMany(mockRecords, parent);

      expect(result.createdItems).to.be.an('array').that.has.length(2);
      expect(result.createdItems[0].record).to.deep.include(mockRecord);
      expect(result.createdItems[1].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.put.calledThrice).to.be.true;
      expect(mockLogger.warn).to.not.have.been.called;
    });

    it('logs warning if parent is invalid', async () => {
      const mockRecords = [mockRecord, mockRecord];
      const mockPutResults = {
        type: 'query',
        method: 'batchWrite',
        params: {
          RequestItems: {
            mockEntityModel: [
              { PutRequest: { Item: mockRecord } },
              { PutRequest: { Item: mockRecord } },
            ],
          },
        },
      };
      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.resolve(mockPutResults),
          params: () => ({ Item: { ...mockRecord } }),
        },
      );

      const idNotMatchingParent = {
        record: { mockParentEntityModelId: 'invalid-id' },
        entityName: 'mockParentEntityModel',
        entity: { model: { name: 'mockParentEntityModel' } },
      };

      const noEntityParent = {
        record: { mockParentEntityModelId: 'invalid-id' },
        entity: { model: { name: 'mockParentEntityModel' } },
      };

      const r1 = await baseCollectionInstance.createMany(mockRecords, idNotMatchingParent);
      const r2 = await baseCollectionInstance.createMany(mockRecords, noEntityParent);

      expect(r1.createdItems).to.be.an('array').that.has.length(2);
      expect(r1.createdItems[0].record).to.deep.include(mockRecord);
      expect(r1.createdItems[1].record).to.deep.include(mockRecord);

      expect(r2.createdItems).to.be.an('array').that.has.length(2);
      expect(r2.createdItems[0].record).to.deep.include(mockRecord);
      expect(r2.createdItems[1].record).to.deep.include(mockRecord);

      expect(mockElectroService.entities.mockEntityModel.put).to.have.callCount(6);
      expect(mockLogger.warn).to.have.callCount(4);
    });

    it('creates some entities successfully with unprocessed items', async () => {
      const mockRecords = [mockRecord, mockRecord];
      let itemCount = 0;

      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.resolve({ unprocessed: [mockRecord] }),
          params: () => {
            if (itemCount === 0) {
              itemCount += 1;
              return { Item: { ...mockRecord } };
            } else {
              throw new ElectroValidationError('Validation failed');
            }
          },
        },
      );

      const result = await baseCollectionInstance.createMany(mockRecords);
      expect(result.createdItems).to.be.an('array').that.has.length(1);
      expect(result.createdItems[0].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.put.calledThrice).to.be.true;
      expect(mockLogger.error.calledOnceWith(`Failed to process all items in batch write for [mockEntityModel]: ${JSON.stringify([mockRecord])}`)).to.be.true;
    });

    it('fails creating some items due to ValidationError', async () => {
      const error = new ElectroValidationError('Validation failed');
      mockElectroService.entities.mockEntityModel.put.returns(
        { params: () => { throw error; } },
      );

      const result = await baseCollectionInstance.createMany([mockRecord]);
      expect(result.createdItems).to.be.an('array').that.has.length(0);
      expect(result.errorItems).to.be.an('array').that.has.length(1);
      expect(result.errorItems[0].item).to.deep.include(mockRecord);
    });

    it('logs an error and throws when creation fails', async () => {
      const error = new Error('Create failed');
      const mockRecords = [mockRecord, mockRecord];
      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.reject(error),
          params: () => ({ Item: { ...mockRecord } }),
        },
      );

      await expect(baseCollectionInstance.createMany(mockRecords)).to.be.rejectedWith('Failed to create many');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('calls the on-create-many handler if provided', async () => {
      mockElectroService.entities.mockEntityModel.put.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );

      const onCreateMany = stub().resolves();
      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      // eslint-disable-next-line no-underscore-dangle
      instance._onCreateMany = onCreateMany;

      await instance.createMany([mockRecord]);

      expect(onCreateMany).to.have.been.calledOnce;
    });

    it('logs error if onCreateMany handler fails', async () => {
      const error = new Error('On-create-many failed');
      mockElectroService.entities.mockEntityModel.put.returns(
        { go: () => Promise.resolve({ data: mockRecord }) },
      );

      const onCreateMany = stub().rejects(error);
      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      // eslint-disable-next-line no-underscore-dangle
      instance._onCreateMany = onCreateMany;

      await instance.createMany([mockRecord]);

      expect(onCreateMany).to.have.been.calledOnce;
      expect(mockLogger.error).to.have.been.calledOnceWith('On-create-many handler failed');
    });
  });

  describe('_saveMany', () => { /* eslint-disable no-underscore-dangle */
    it('throws an error if the records are empty', async () => {
      await expect(baseCollectionInstance._saveMany(null))
        .to.be.rejectedWith('Failed to save many [mockEntityModel]: items must be a non-empty array');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('saves multiple entities successfully', async () => {
      const mockRecords = [mockRecord, mockRecord];
      mockElectroService.entities.mockEntityModel.put.returns({ go: () => [] });

      const result = await baseCollectionInstance._saveMany(mockRecords);
      expect(result).to.be.undefined;
      expect(mockElectroService.entities.mockEntityModel.put.calledOnce).to.be.true;
    });

    it('saves some entities successfully with unprocessed items', async () => {
      const mockRecords = [mockRecord, mockRecord];
      mockElectroService.entities.mockEntityModel.put.returns(
        {
          go: () => Promise.resolve({ unprocessed: [mockRecord] }),
        },
      );

      const result = await baseCollectionInstance._saveMany(mockRecords);
      expect(result).to.be.undefined;
      expect(mockElectroService.entities.mockEntityModel.put.calledOnce).to.be.true;
      expect(mockLogger.error.calledOnceWith(`Failed to process all items in batch write for [mockEntityModel]: ${JSON.stringify([mockRecord])}`)).to.be.true;
    });

    it('throws error and logs when save fails', async () => {
      const error = new Error('Save failed');
      const mockRecords = [mockRecord, mockRecord];
      mockElectroService.entities.mockEntityModel.put.returns(
        { go: () => Promise.reject(error) },
      );

      await expect(baseCollectionInstance._saveMany(mockRecords)).to.be.rejectedWith(DataAccessError, 'Failed to save many');
      expect(mockLogger.error.calledOnce).to.be.true;
    });
  });

  describe('all', () => {
    it('returns all entities successfully', async () => {
      const mockFindResult = { data: [mockRecord] };
      mockElectroService.entities.mockEntityModel.query.all.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const result = await baseCollectionInstance.all();
      expect(result).to.be.an('array').that.has.length(1);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.query.all)
        .to.have.been.calledOnceWithExactly({ pk: 'ALL_MOCKENTITYMODELS' });
    });

    it('applies between filter if provided', async () => {
      const mockFindResult = { data: [mockRecord] };
      const mockGo = stub().resolves(mockFindResult);
      const mockBetween = stub().returns({ go: mockGo });
      mockElectroService.entities.mockEntityModel.query.all().between = mockBetween;

      const result = await baseCollectionInstance.all(
        {},
        { between: { attribute: 'test', start: 'a', end: 'b' } },
      );

      expect(result).to.be.an('array').that.has.length(1);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(mockBetween).to.have.been.calledOnceWithExactly({ test: 'a' }, { test: 'b' });
      expect(mockGo).to.have.been.calledOnceWithExactly({ order: 'desc' });
    });

    it('applies attribute filter if provided', async () => {
      const mockFindResult = { data: [mockRecord] };
      const mockGo = stub().resolves(mockFindResult);
      mockElectroService.entities.mockEntityModel.query.all.returns(
        { go: mockGo },
      );

      const result = await baseCollectionInstance.all({}, { attributes: ['test'] });

      expect(result).to.be.an('array').that.has.length(1);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.query.all)
        .to.have.been.calledOnceWithExactly({ pk: 'ALL_MOCKENTITYMODELS' });
      expect(mockGo).to.have.been.calledOnceWithExactly({ order: 'desc', attributes: ['test'] });
    });

    it('handles pagination with fetchAllPages option', async () => {
      const firstResult = { data: [mockRecord], cursor: 'key1' };
      const secondRecord = { id: '2', foo: 'bar' };
      const secondResult = { data: [secondRecord] };

      const goStub = stub();
      goStub.onFirstCall().resolves(firstResult);
      goStub.onSecondCall().resolves(secondResult);

      mockElectroService.entities.mockEntityModel.query.all.returns({
        go: goStub,
      });

      const result = await baseCollectionInstance.all({}, { fetchAllPages: true });
      expect(result).to.be.an('array').that.has.length(2);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(result[1].record).to.deep.include(secondRecord);

      expect(goStub.callCount).to.equal(2);

      const secondCallArgs = goStub.secondCall.args[0];
      expect(secondCallArgs).to.deep.include({ order: 'desc', cursor: 'key1' });
    });
  });

  describe('allByIndexKeys', () => {
    it('throws error if keys is not provided', async () => {
      await expect(baseCollectionInstance.allByIndexKeys())
        .to.be.rejectedWith('Failed to query [mockEntityModel]: keys are required');
      expect(mockLogger.error).to.have.been.calledOnce;
    });

    it('throws and error if options is not an object', async () => {
      await expect(baseCollectionInstance.allByIndexKeys({ someKey: 'someValue' }, null))
        .to.be.rejectedWith('Failed to query [mockEntityModel]: options must be an object');
      expect(mockLogger.error).to.have.been.calledOnce;
    });

    it('throws an error if the query operation fails', async () => {
      const error = new Error('Query failed');
      mockElectroService.entities.mockEntityModel.query.all.returns(
        { go: () => Promise.reject(error) },
      );

      await expect(baseCollectionInstance.allByIndexKeys({ someKey: 'someValue' }))
        .to.be.rejectedWith(DataAccessError, 'Failed to query');
      expect(mockLogger.error).to.have.been.calledOnce;
    });

    it('successfully queries entities by index keys', async () => {
      const mockFindResult = { data: [mockRecord] };

      mockIndexes = {
        bySomeKey: { index: 'bySomeKey', pk: { facets: ['someKey'] }, sk: { facets: ['someOtherKey'] } },
      };

      mockElectroService.entities.mockEntityModel.query.bySomeKey.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      const result = await instance.allByIndexKeys({ someKey: 'someValue' });

      expect(result).to.be.an('array').that.has.length(1);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.query.bySomeKey)
        .to.have.been.calledOnceWithExactly({ someKey: 'someValue' });
    });

    it('successfully queries entities by primary index keys', async () => {
      const mockFindResult = { data: [mockRecord] };

      delete mockElectroService.entities.mockEntityModel.query.all;
      delete mockElectroService.entities.mockEntityModel.query.bySomeKey;
      delete mockIndexes.all;

      mockElectroService.entities.mockEntityModel.query.primary.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const instance = createInstance(
        mockElectroService,
        mockEntityRegistry,
        mockIndexes,
        mockLogger,
      );

      const result = await instance.allByIndexKeys({ someKey: 'someValue' });

      expect(result).to.be.an('array').that.has.length(1);
      expect(result[0].record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.query.primary)
        .to.have.been.calledOnceWithExactly({ someKey: 'someValue' });
    });
  });

  describe('findByAll', () => {
    it('throws an error if sortKeys is not an object', async () => {
      await expect(baseCollectionInstance.findByAll(null))
        .to.be.rejectedWith('Failed to find by all [mockEntityModel]: sort keys must be an object');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('finds all entities successfully', async () => {
      const mockFindResult = { data: [mockRecord] };
      mockElectroService.entities.mockEntityModel.query.all.returns(
        { go: () => Promise.resolve(mockFindResult) },
      );

      const result = await baseCollectionInstance.findByAll({ someKey: 'someValue' });
      expect(result.record).to.deep.include(mockRecord);
      expect(mockElectroService.entities.mockEntityModel.query.all)
        .to.have.been.calledOnceWithExactly(
          { pk: 'ALL_MOCKENTITYMODELS', someKey: 'someValue' },
        );
    });

    it('returns null if the entity is not found', async () => {
      const result = await baseCollectionInstance.findByAll({ someKey: 'someValue' });
      expect(result).to.be.null;
      expect(mockElectroService.entities.mockEntityModel.query.all)
        .to.have.been.calledOnceWithExactly(
          { pk: 'ALL_MOCKENTITYMODELS', someKey: 'someValue' },
        );
    });
  });

  describe('removeByIds', () => {
    it('throws an error if the ids are not an array', async () => {
      await expect(baseCollectionInstance.removeByIds(null))
        .to.be.rejectedWith('Failed to remove [mockEntityModel]: ids must be a non-empty array');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('throws an error if the ids are empty', async () => {
      await expect(baseCollectionInstance.removeByIds([]))
        .to.be.rejectedWith('Failed to remove [mockEntityModel]: ids must be a non-empty array');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('throws error if delete operation fails', async () => {
      const error = new Error('Delete failed');
      mockElectroService.entities.mockEntityModel.delete.returns(
        { go: () => Promise.reject(error) },
      );
      mockElectroService.entities.mockEntityModel.get.returns({
        go: () => Promise.resolve({ data: mockRecord }),
      });

      await expect(baseCollectionInstance.removeByIds(['ef39921f-9a02-41db-b491-02c98987d956']))
        .to.be.rejectedWith(DataAccessError, 'Failed to remove');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('removes entities successfully', async () => {
      const mockIds = ['ef39921f-9a02-41db-b491-02c98987d956', 'ef39921f-9a02-41db-b491-02c98987d957'];
      mockElectroService.entities.mockEntityModel.delete.returns({ go: () => Promise.resolve() });
      mockElectroService.entities.mockEntityModel.get.returns({
        // TODO fix! Instead of the mockRecord it should return the record for the ID passed in
        go: () => Promise.resolve({ data: mockRecord }),
      });
      await baseCollectionInstance.removeByIds(mockIds);
      expect(mockElectroService.entities.mockEntityModel.delete)
        .to.have.been.calledOnceWithExactly([
          { mockEntityModelId: 'ef39921f-9a02-41db-b491-02c98987d956' },
          { mockEntityModelId: 'ef39921f-9a02-41db-b491-02c98987d957' },
        ]);
    });
  });
});
