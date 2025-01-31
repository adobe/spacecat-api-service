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
import sinonChai from 'sinon-chai';

import { SchemaError, SchemaValidationError } from '../../../../src/errors/index.js';
import BaseModel from '../../../../src/models/base/base.model.js';
import BaseCollection from '../../../../src/models/base/base.collection.js';
import Schema from '../../../../src/models/base/schema.js';
import Reference from '../../../../src/models/base/reference.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

const MockModel = class MockEntityModel extends BaseModel {};
const MockCollection = class MockEntityCollection extends BaseCollection {};

describe('Schema', () => {
  let rawSchema;
  let instance;

  beforeEach(() => {
    rawSchema = {
      serviceName: 'service',
      schemaVersion: 1,
      attributes: {
        id: { type: 'string' },
      },
      indexes: {
        primary: { pk: { composite: ['id'] } },
        byOrganizationId: { index: 'gsi1pk-gsi1pk', sk: { facets: ['organizationId'] }, indexType: 'belongs_to' },
      },
      references: [new Reference('belongs_to', 'Organization')],
      options: { allowRemove: true, allowUpdates: true },
    };

    instance = new Schema(MockModel, MockCollection, rawSchema);
  });

  describe('constructor', () => {
    it('constructs a new Schema instance', () => {
      const schema = new Schema(MockModel, MockCollection, rawSchema);

      expect(schema.modelClass).to.equal(MockModel);
      expect(schema.collectionClass).to.equal(MockCollection);
      expect(schema.serviceName).to.equal('service');
      expect(schema.schemaVersion).to.equal(1);
      expect(schema.attributes).to.deep.equal({ id: { type: 'string' } });
      expect(schema.indexes).to.deep.equal(rawSchema.indexes);
      expect(schema.references).to.deep.equal([{
        options: {},
        target: 'Organization',
        type: 'belongs_to',
      }]);
    });

    it('throws an error if modelClass does not extend BaseModel', () => {
      expect(() => new Schema({}, MockCollection, rawSchema)).to.throw(SchemaValidationError, 'Model class must extend BaseModel');
      expect(() => new Schema(String, MockCollection, rawSchema)).to.throw(SchemaValidationError, 'Model class must extend BaseModel');
    });

    it('throws an error if collectionClass does not extend BaseCollection', () => {
      expect(() => new Schema(MockModel, {}, rawSchema)).to.throw(SchemaValidationError, 'Collection class must extend BaseCollection');
      expect(() => new Schema(MockModel, String, rawSchema)).to.throw(SchemaValidationError, 'Collection class must extend BaseCollection');
    });

    it('throws an error if schema does not have a service name', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, serviceName: '' })).to.throw(SchemaValidationError, 'Schema must have a service name');
    });

    it('throws an error if schema does not have a positive integer', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, schemaVersion: 0 })).to.throw(SchemaValidationError, 'Schema version must be a positive integer');
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, schemaVersion: 'test' })).to.throw(SchemaValidationError, 'Schema version must be a positive integer');
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, schemaVersion: undefined })).to.throw(SchemaValidationError, 'Schema version must be a positive integer');
    });

    it('throws an error if schema does not have attributes', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, attributes: {} })).to.throw(SchemaValidationError, 'Schema must have attributes');
    });

    it('throws an error if schema does not have indexes', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, indexes: {} })).to.throw(SchemaValidationError, 'Schema must have indexes');
    });

    it('throws an error if schema does not have references', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, references: 'test' })).to.throw(SchemaValidationError, 'References must be an array');
    });

    it('throws an error if schema does not have options', () => {
      expect(() => new Schema(MockModel, MockCollection, { ...rawSchema, options: {} })).to.throw(SchemaValidationError, 'Schema must have options');
    });

    it('references default to an empty array', () => {
      const schema = new Schema(MockModel, MockCollection, { ...rawSchema, references: undefined });

      expect(schema.references).to.deep.equal([]);
    });

    it('options default to updates and removes allowed', () => {
      const schema = new Schema(MockModel, MockCollection, { ...rawSchema });

      expect(schema.options).to.deep.equal({ allowRemove: true, allowUpdates: true });
    });
  });

  describe('accessors', () => {
    it('allowsRemove', () => {
      expect(instance.allowsRemove()).to.be.true;
    });

    it('allowsUpdates', () => {
      expect(instance.allowsUpdates()).to.be.true;
    });

    it('getAttribute', () => {
      expect(instance.getAttribute('id')).to.deep.equal({ type: 'string' });
    });

    it('getAttributes', () => {
      expect(instance.getAttributes()).to.deep.equal({ id: { type: 'string' } });
    });

    it('getCollectionName', () => {
      expect(instance.getCollectionName()).to.equal('MockEntityCollection');
    });

    it('getEntityName', () => {
      expect(instance.getEntityName()).to.equal('mockEntityModel');
    });

    it('getIdName', () => {
      expect(instance.getIdName()).to.equal('mockEntityModelId');
    });

    it('findIndexByType returns null if no index is found', () => {
      expect(instance.findIndexByType('other')).to.equal(null);
    });

    it('findIndexByType returns index', () => {
      expect(instance.findIndexByType('belongs_to')).to.deep.equal({
        index: 'gsi1pk-gsi1pk',
        indexType: 'belongs_to',
        sk: {
          facets: [
            'organizationId',
          ],
        },
      });
    });

    it('findIndexNameByKeys returns primary if no index found', () => {
      expect(instance.findIndexNameByKeys({ someKey: 'someValue' })).to.equal('primary');
    });

    it('findIndexNameByKeys returns index if found', () => {
      expect(instance.findIndexNameByKeys({ organizationId: 'someId' })).to.equal('gsi1pk-gsi1pk');
    });

    it('findIndexNameByKeys returns primary if index found but no name', () => {
      delete rawSchema.indexes.byOrganizationId.index;
      expect(instance.findIndexNameByKeys({ organizationId: 'someId' })).to.equal('primary');
    });

    it('findIndexNameByKeys returns all index if index not found and all available', () => {
      delete rawSchema.indexes.byOrganizationId;
      rawSchema.indexes.all = { index: 'all-index', indexType: 'all', pk: { composite: ['id'] } };
      expect(instance.findIndexNameByKeys({ organizationId: 'someId' })).to.equal('all-index');
    });

    it('getIndexAccessors', () => {
      expect(instance.getIndexAccessors()).to.deep.equal([{
        indexName: 'byOrganizationId',
        keySets: [['organizationId']],
      }]);
    });

    it('getIndexByName', () => {
      expect(instance.getIndexByName('primary')).to.deep.equal({ pk: { composite: ['id'] } });
    });

    it('getIndexes', () => {
      expect(instance.getIndexes()).to.deep.equal(rawSchema.indexes);
    });

    it('getIndexes with exclusion', () => {
      expect(instance.getIndexes(['primary'])).to.deep.equal({
        byOrganizationId: { index: 'gsi1pk-gsi1pk', sk: { facets: ['organizationId'] }, indexType: 'belongs_to' },
      });
    });

    it('getIndexKeys', () => {
      expect(instance.getIndexKeys('byOrganizationId')).to.deep.equal(['organizationId']);
    });

    it('getIndexKeys with non-existent index', () => {
      expect(instance.getIndexKeys('non-existent')).to.deep.equal([]);
    });

    it('getModelClass', () => {
      expect(instance.getModelClass()).to.equal(MockModel);
    });

    it('getModelName', () => {
      expect(instance.getModelName()).to.equal('MockEntityModel');
    });

    it('getReciprocalReference', () => {
      const reciprocalReference = new Reference('belongs_to', 'MockEntityModel');
      const registry = {
        getCollection: () => ({
          schema: { getReferenceByTypeAndTarget: () => reciprocalReference },
        }),
      };

      expect(instance.getReciprocalReference(registry, new Reference('has_many', 'Organization')))
        .to.deep.equal(reciprocalReference);
      expect(instance.getReciprocalReference(registry, new Reference('belongs_to', 'Organization')))
        .to.be.null;
    });

    it('getReferences', () => {
      expect(instance.getReferences()).to.deep.equal([{
        options: {},
        target: 'Organization',
        type: 'belongs_to',
      }]);
    });

    it('getReferencesByType', () => {
      expect(instance.getReferencesByType('belongs_to')).to.deep.equal([{
        options: {},
        target: 'Organization',
        type: 'belongs_to',
      }]);
    });

    it('getServiceName', () => {
      expect(instance.getServiceName()).to.equal('service');
    });

    it('getVersion', () => {
      expect(instance.getVersion()).to.equal(1);
    });
  });

  describe('toAccessorConfigs', () => {
    it('throws error if entity is not a base model or collection', () => {
      expect(() => instance.toAccessorConfigs({}, {}))
        .to.throw(SchemaError, '[MockEntityModel] Entity must extend BaseModel or BaseCollection');
    });
  });

  describe('toElectroDBSchema', () => {
    it('returns an ElectroDB-compatible schema', () => {
      expect(instance.toElectroDBSchema()).to.deep.equal({
        model: {
          entity: 'MockEntityModel',
          version: '1',
          service: 'service',
        },
        attributes: { id: { type: 'string' } },
        indexes: rawSchema.indexes,
      });
    });
  });
});
