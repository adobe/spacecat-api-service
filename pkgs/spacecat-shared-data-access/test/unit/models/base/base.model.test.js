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
import { Entity } from 'electrodb';
import { spy, stub } from 'sinon';
import sinonChai from 'sinon-chai';

import BaseModel from '../../../../src/models/base/base.model.js';
import KeyEventSchema from '../../../../src/models/key-event/key-event.schema.js';
import OpportunitySchema from '../../../../src/models/opportunity/opportunity.schema.js';
import SuggestionSchema from '../../../../src/models/suggestion/suggestion.schema.js';
import Reference from '../../../../src/models/base/reference.js';
import BaseCollection from '../../../../src/models/base/base.collection.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

const opportunityEntity = new Entity(OpportunitySchema.toElectroDBSchema());
const suggestionEntity = new Entity(SuggestionSchema.toElectroDBSchema());
const MockCollection = class MockCollection extends BaseCollection { };

describe('BaseModel', () => { /* eslint-disable no-underscore-dangle */
  let mockElectroService;
  let baseModelInstance;
  let mockLogger;
  let mockEntityRegistry;

  const mockRecord = {
    opportunityId: '12345',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recordExpiresAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockLogger = {
      debug: spy(),
      error: spy(),
      info: spy(),
      warn: spy(),
    };

    mockEntityRegistry = {
      log: mockLogger,
      getCollection: stub().returns({
        schema: {
          getReferenceByTypeAndTarget: stub().returns(null),
          getModelName: stub().returns('Opportunity'),
        },
      }),
    };

    mockEntityRegistry.getCollection.withArgs('OpportunityCollection').returns({
      log: mockLogger,
      findByIndexKeys: stub().resolves({}),
      allByIndexKeys: stub().resolves([]),
      schema: {
        getReferenceByTypeAndTarget: stub().returns(null),
        getModelName: stub().returns('Opportunity'),
      },
    });

    mockElectroService = {
      entities: {
        opportunity: {
          entity: opportunityEntity,
          remove: stub().returns({ go: stub().resolves() }),
          _remove: stub().returns({ go: stub().resolves() }),
        },
        suggestion: {
          entity: suggestionEntity,
          query: {
            primary: stub().returns({ go: stub().resolves({ data: [mockRecord] }) }),
            'spacecat-data-gsi1pk-gsi1sk': stub().returns({ go: stub().resolves({ data: [mockRecord] }) }),
          },
          remove: stub().returns({ go: stub().resolves() }),
          _remove: stub().returns({ go: stub().resolves() }),
          indexes: {
            primary: {},
          },
        },
      },
    };

    const SuggestionCollection = new MockCollection(
      mockElectroService,
      mockEntityRegistry,
      SuggestionSchema,
      mockLogger,
    );

    mockEntityRegistry.getCollection.withArgs('SuggestionCollection').returns(SuggestionCollection);

    baseModelInstance = new BaseModel(
      mockElectroService,
      mockEntityRegistry,
      OpportunitySchema,
      mockRecord,
      mockLogger,
    );
  });

  describe('base', () => {
    it('creates a new instance of BaseModel', () => {
      expect(baseModelInstance).to.be.an.instanceOf(BaseModel);
    });

    it('returns when initializeAttributes has no attributes', () => {
      const originalAttributes = { ...OpportunitySchema.attributes };
      OpportunitySchema.attributes = {};

      const instance = new BaseModel(
        mockElectroService,
        mockEntityRegistry,
        OpportunitySchema,
        {},
        mockLogger,
      );

      expect(instance).to.be.an.instanceOf(BaseModel);

      OpportunitySchema.attributes = originalAttributes;
    });
  });

  describe('getId', () => {
    it('returns the ID of the entity', () => {
      const id = baseModelInstance.getId();
      expect(id).to.equal('12345');
    });
  });

  describe('recordExpiresAt', () => {
    it('gets recordExpiresAt', () => {
      const recordExpiresAt = baseModelInstance.getRecordExpiresAt();
      expect(recordExpiresAt).to.equal(mockRecord.recordExpiresAt);
    });
  });

  describe('getCreatedAt', () => {
    it('returns the creation timestamp in ISO format', () => {
      const createdAt = baseModelInstance.getCreatedAt();
      expect(createdAt).to.equal(mockRecord.createdAt);
    });
  });

  describe('getUpdatedAt', () => {
    it('returns the updated timestamp in ISO format', () => {
      const updatedAt = baseModelInstance.getUpdatedAt();
      expect(updatedAt).to.equal(mockRecord.updatedAt);
    });
  });

  describe('remove', () => {
    let dependent;
    let dependents;
    let schema;
    let originalReferences = [];

    beforeEach(() => {
      dependent = { _remove: stub().resolves() };
      dependents = [dependent, dependent, dependent];
      originalReferences = [...OpportunitySchema.references];
      schema = OpportunitySchema;

      const collectionMethods = {
        findByIndexKeys: stub().resolves(dependent),
        allByIndexKeys: stub().resolves(dependents),
        schema: {
          getReferenceByTypeAndTarget: stub().returns(null),
        },
      };

      mockEntityRegistry.getCollection.withArgs('SuggestionCollection').returns(collectionMethods);
      mockEntityRegistry.getCollection.withArgs('SomeModelCollection').returns(collectionMethods);
      mockElectroService.entities.opportunity.remove.returns({ go: () => Promise.resolve() });
    });

    afterEach(() => {
      OpportunitySchema.references = originalReferences;
    });

    it('removes the record and returns the current instance', async () => {
      await expect(baseModelInstance.remove()).to.eventually.equal(baseModelInstance);

      expect(mockElectroService.entities.opportunity.remove.calledOnce).to.be.true;
      expect(mockLogger.error.notCalled).to.be.true;
    });

    it('removes record with dependents', async () => {
      const reference = Reference.fromJSON({
        type: Reference.TYPES.HAS_ONE,
        target: 'SomeModel',
        options: { removeDependents: true },
      });

      baseModelInstance.getSomeModel = stub().resolves(dependent);
      baseModelInstance.getSuggestions = stub().resolves(dependents);

      schema.references.push(reference);

      await expect(baseModelInstance.remove()).to.eventually.equal(baseModelInstance);

      // self remove
      expect(mockElectroService.entities.opportunity.remove.calledOnce).to.be.true;
      // dependents remove: 3 = has_many, 1 = has_one
      expect(dependent._remove).to.have.callCount(4);
      expect(baseModelInstance.getSomeModel).to.have.been.calledOnce;
      expect(mockLogger.error).to.not.have.been.called;
    });

    it('does not remove dependents if there aren\'t any', async () => {
      schema.references = [];

      await expect(baseModelInstance.remove()).to.eventually.equal(baseModelInstance);

      expect(dependent._remove.notCalled).to.be.true;
    });

    it('does not remove dependents if none are found', async () => {
      schema.references[0].options.removeDependents = true;
      schema.references[1].options.removeDependents = true;
      mockEntityRegistry.getCollection = () => ({
        allByIndexKeys: stub().resolves([]),
        schema: {
          getReferenceByTypeAndTarget: stub().returns(null),
          getModelName: stub().returns('SomeModel'),
        },
      });

      const instance = new BaseModel(
        mockElectroService,
        mockEntityRegistry,
        OpportunitySchema,
        mockRecord,
        mockLogger,
      );

      await expect(instance.remove()).to.eventually.equal(instance);

      expect(dependent._remove.notCalled).to.be.true;
    });

    it('logs an error and throws if removal of a dependent fails', async () => {
      const reference = Reference.fromJSON({
        type: Reference.TYPES.HAS_ONE,
        target: 'SomeModel',
        options: { removeDependents: true },
      });

      baseModelInstance.getSomeModel = stub().resolves(dependent);
      baseModelInstance.getSuggestions = stub().resolves(dependents);

      schema.references.push(reference);

      const error = new Error('Remove failed');
      dependent._remove = stub().returns(Promise.reject(error));

      await expect(baseModelInstance.remove()).to.be.rejectedWith('Failed to remove entity opportunity with ID 12345');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('logs an error and throws when remove fails', async () => {
      const error = new Error('Remove failed');
      mockElectroService.entities.opportunity.remove.returns({ go: () => Promise.reject(error) });

      await expect(baseModelInstance.remove()).to.be.rejectedWith('Failed to remove entity opportunity with ID 12345');
      expect(mockLogger.error.calledOnce).to.be.true;
    });

    it('throws an error if the schema does not allow removal', async () => {
      OpportunitySchema.options.allowRemove = false;

      await expect(baseModelInstance.remove()).to.be.rejectedWith('The entity Opportunity does not allow removal');
      expect(mockElectroService.entities.opportunity.remove.notCalled).to.be.true;
    });
  });

  describe('save', () => {
    it('saves the record and returns the current instance', async () => {
      baseModelInstance.patcher.save = stub().returns(Promise.resolve());
      await expect(baseModelInstance.save()).to.eventually.equal(baseModelInstance);
      expect(baseModelInstance.patcher.save.calledOnce).to.be.true;
      expect(mockLogger.error.notCalled).to.be.true;
    });

    it('logs an error and throws when save fails', async () => {
      const error = new Error('Save failed');
      baseModelInstance.patcher.save = stub().returns(Promise.reject(error));

      await expect(baseModelInstance.save()).to.be.rejectedWith('Failed to to save entity opportunity with ID 12345');
      expect(mockLogger.error.calledOnce).to.be.true;
    });
  });

  describe('references', () => { /* eslint-disable no-underscore-dangle */
    describe('reciprocal', () => {
      it('logs a warning if reference is not found', async () => {
        mockEntityRegistry.getCollection.withArgs('FooCollection').returns(new MockCollection(
          mockElectroService,
          mockEntityRegistry,
          KeyEventSchema,
          mockLogger,
        ));
        OpportunitySchema.references.push(new Reference('has_many', 'Foos'));

        const result = new BaseModel(
          mockElectroService,
          mockEntityRegistry,
          OpportunitySchema,
          mockRecord,
          mockLogger,
        );

        expect(result).to.be.an.instanceOf(BaseModel);
        expect(mockLogger.warn).to.have.been.calledOnceWithExactly('Reciprocal reference not found for Opportunity to Foos');
      });

      it('logs a debug message if reference sort keys are empty', async () => {
        SuggestionSchema.references = [new Reference('belongs_to', 'Opportunity', { sortKeys: [] })];

        const result = new BaseModel(
          mockElectroService,
          mockEntityRegistry,
          OpportunitySchema,
          mockRecord,
          mockLogger,
        );

        expect(result).to.be.an.instanceOf(BaseModel);
        expect(mockLogger.debug).to.have.been.calledWithExactly('No sort keys defined for Opportunity to Suggestions');
      });
    });
  });
});
