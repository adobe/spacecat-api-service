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
import { isIsoDate } from '@adobe/spacecat-shared-utils';
import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import { validate as uuidValidate } from 'uuid';

import SchemaBuilder from '../../../../src/models/base/schema.builder.js';
import { BaseCollection, BaseModel, SchemaBuilderError } from '../../../../src/index.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('SchemaBuilder', () => {
  const MockModel = class MockModel extends BaseModel {};
  const MockCollection = class MockCollection extends BaseCollection {};

  let instance;

  beforeEach(() => {
    instance = new SchemaBuilder(MockModel, MockCollection);
  });

  describe('constructor', () => {
    it('throws error if invalid model class is provided', () => {
      expect(() => new SchemaBuilder())
        .to.throw(SchemaBuilderError, 'modelClass must be a subclass of BaseModel.');
      expect(() => new SchemaBuilder(Number))
        .to.throw(SchemaBuilderError, 'modelClass must be a subclass of BaseModel.');
    });

    it('throws error if invalid collection class is provided', () => {
      expect(() => new SchemaBuilder(MockModel))
        .to.throw(SchemaBuilderError, 'collectionClass must be a subclass of BaseCollection.');
      expect(() => new SchemaBuilder(MockModel, Number))
        .to.throw(SchemaBuilderError, 'collectionClass must be a subclass of BaseCollection.');
    });

    it('throws an error if version is not a positive integer', () => {
      expect(() => new SchemaBuilder(MockModel, MockCollection, -1))
        .to.throw(SchemaBuilderError, 'schemaVersion is required and must be a positive integer.');
      expect(() => new SchemaBuilder(MockModel, MockCollection, '-1'))
        .to.throw(SchemaBuilderError, 'schemaVersion is required and must be a positive integer.');
      expect(() => new SchemaBuilder(MockModel, MockCollection, 1.2))
        .to.throw(SchemaBuilderError, 'schemaVersion is required and must be a positive integer.');
    });

    it('successfully creates an instance', () => {
      expect(instance).to.be.an.instanceOf(SchemaBuilder);
      expect(instance.entityName).to.equal('MockModel');
      expect(instance.serviceName).to.equal('SpaceCat');
      expect(instance.schemaVersion).to.equal(1);
      expect(instance.indexes).to.deep.equal({});
      expect(instance.references).to.deep.equal([]);
      expect(instance.attributes).to.deep.equal({
        mockModelId: {
          default: instance.attributes.mockModelId.default,
          type: 'string',
          required: true,
          readOnly: true,
          validate: instance.attributes.mockModelId.validate,
        },
        createdAt: {
          default: instance.attributes.createdAt.default,
          type: 'string',
          readOnly: true,
          required: true,
        },
        updatedAt: {
          default: instance.attributes.updatedAt.default,
          type: 'string',
          required: true,
          readOnly: true,
          watch: '*',
          set: instance.attributes.updatedAt.set,
        },
      });

      expect(instance.rawIndexes).to.deep.equal({
        primary: {
          pk: { composite: ['mockModelId'], field: 'pk' },
          sk: { composite: [], field: 'sk' },
        },
        all: [],
        belongs_to: [],
        other: [],
      });
    });
  });

  describe('withPrimaryPartitionKeys', () => {
    it('throws error if partition keys are not provided', () => {
      expect(() => instance.withPrimaryPartitionKeys())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Partition keys are required and must be a non-empty array.');
      expect(() => instance.withPrimaryPartitionKeys('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Partition keys are required and must be a non-empty array.');
    });

    it('successfully sets primary partition keys', () => {
      const result = instance.withPrimaryPartitionKeys(['test']);

      expect(result).to.equal(instance);
      expect(instance.rawIndexes.primary.pk.composite).to.deep.equal(['test']);
    });
  });

  describe('withPrimarySortKeys', () => {
    it('throws error if sort keys are not provided', () => {
      expect(() => instance.withPrimarySortKeys())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort keys are required and must be a non-empty array.');
      expect(() => instance.withPrimarySortKeys('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort keys are required and must be a non-empty array.');
    });

    it('successfully sets primary sort keys', () => {
      const result = instance.withPrimarySortKeys(['test']);

      expect(result).to.equal(instance);
      expect(instance.rawIndexes.primary.sk.composite).to.deep.equal(['test']);
    });
  });

  describe('withRecordExpiry', () => {
    it('throws an error if ttl is not a positive integer', () => {
      expect(() => instance.withRecordExpiry(-1)).to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] TTL must be a positive integer.');
    });
  });

  describe('withUpsertable', () => {
    it('throws error if upsertable is not a boolean', () => {
      expect(() => instance.withUpsertable('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] allow must be a boolean.');
    });
  });

  describe('allowRemove', () => {
    it('throws error if allowRemove is not a boolean', () => {
      expect(() => instance.allowRemove('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] allow must be a boolean.');
    });

    it('successfully sets allowRemove to true', () => {
      const result = instance.allowRemove(true);

      expect(result).to.equal(instance);
      expect(instance.options.allowRemove).to.be.true;
    });

    it('successfully sets allowRemove to false', () => {
      const result = instance.allowRemove(false);

      expect(result).to.equal(instance);
      expect(instance.options.allowRemove).to.be.false;
    });
  });

  describe('allowUpdates', () => {
    it('throws error if allowUpdates is not a boolean', () => {
      expect(() => instance.allowUpdates('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] allow must be a boolean.');
    });

    it('successfully sets allowUpdates to true', () => {
      const result = instance.allowUpdates(true);

      expect(result).to.equal(instance);
      expect(instance.options.allowUpdates).to.be.true;
    });

    it('successfully sets allowUpdates to false', () => {
      const result = instance.allowUpdates(false);

      expect(result).to.equal(instance);
      expect(instance.options.allowUpdates).to.be.false;
    });
  });

  describe('addAttribute', () => {
    it('throws error if attribute name is not provided', () => {
      expect(() => instance.addAttribute())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Attribute name is required and must be non-empty.');
    });

    it('throws error if attribute definition is not provided', () => {
      expect(() => instance.addAttribute('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Attribute data for "test" is required and must be a non-empty object.');
      expect(() => instance.addAttribute('test', 'test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Attribute data for "test" is required and must be a non-empty object.');
      expect(() => instance.addAttribute('test', {}))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Attribute data for "test" is required and must be a non-empty object.');
    });

    it('successfully adds an attribute', () => {
      const result = instance.addAttribute('test', {
        type: 'string',
        required: true,
        default: 'test',
        validate: () => true,
      });

      expect(result).to.equal(instance);
      expect(instance.attributes.test).to.deep.equal({
        type: 'string',
        required: true,
        default: 'test',
        validate: instance.attributes.test.validate,
      });
    });
  });

  describe('addAllIndex', () => {
    it('throws error if no sort keys are provided', () => {
      expect(() => instance.addAllIndex())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort keys are required and must be a non-empty array.');
      expect(() => instance.addAllIndex('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort keys are required and must be a non-empty array.');
    });
  });

  describe('addIndex', () => {
    it('throws error if pk is not provided', () => {
      expect(() => instance.addIndex())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Partition key configuration (pk) is required and must be a non-empty object.');
      expect(() => instance.addIndex('pk'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Partition key configuration (pk) is required and must be a non-empty object.');
      expect(() => instance.addIndex({}))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Partition key configuration (pk) is required and must be a non-empty object.');
    });

    it('throws error if sk is not provided', () => {
      expect(() => instance.addIndex({ composite: ['test'] }))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort key configuration (sk) is required and must be a non-empty object.');
      expect(() => instance.addIndex({ composite: ['test'] }, 'sk'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort key configuration (sk) is required and must be a non-empty object.');
      expect(() => instance.addIndex({ composite: ['test'] }, {}))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Sort key configuration (sk) is required and must be a non-empty object.');
    });

    it('successfully adds an index', () => {
      const result = instance.addIndex({ composite: ['test'] }, { composite: ['test'] });

      expect(result).to.equal(instance);
      expect(instance.rawIndexes.other[0]).to.deep.equal({
        type: 'other',
        pk: { composite: ['test'] },
        sk: { composite: ['test'] },
      });
    });
  });

  describe('addReference', () => {
    it('throws error if reference type is not provided', () => {
      expect(() => instance.addReference())
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Invalid referenceType: "undefined"');
    });

    it('throws error if reference type is invalid', () => {
      expect(() => instance.addReference('test'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Invalid referenceType: "test"');
    });

    it('throws error if entity name is not provided', () => {
      expect(() => instance.addReference('belongs_to'))
        .to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] entityName for reference is required and must be a non-empty string.');
    });

    it('successfully adds a has_many reference', () => {
      const result = instance.addReference('has_many', 'SomeEntity');

      expect(result).to.equal(instance);
      expect(instance.references).to.be.an('array').with.length(1);
      expect(instance.references[0])
        .to.deep.equal({
          options: {
            removeDependents: false,
            sortKeys: [],
          },
          target: 'SomeEntity',
          type: 'has_many',
        });
      expect(instance.attributes).to.not.have.property('someEntityId');
      expect(instance.rawIndexes.belongs_to).to.not.have.property('bySomeEntityId');
    });

    it('successfully adds a has_many reference with removeDependents', () => {
      const result = instance.addReference('has_many', 'SomeEntity', [], { removeDependents: true });

      expect(result).to.equal(instance);
      expect(instance.references).to.be.an('array').with.length(1);
      expect(instance.references[0]).to.deep.equal({
        options: {
          removeDependents: true,
          sortKeys: [],
        },
        target: 'SomeEntity',
        type: 'has_many',
      });
      expect(instance.attributes).to.not.have.property('someEntityId');
      expect(instance.rawIndexes.belongs_to).to.not.have.property('bySomeEntityId');
    });

    it('successfully adds a belongs_to reference', () => {
      const result = instance.addReference('belongs_to', 'SomeEntity');

      expect(result).to.equal(instance);
      expect(instance.references).to.be.an('array').with.length(1);
      expect(instance.references[0]).to.deep.equal({
        options: {
          required: true,
          sortKeys: [],
        },
        target: 'SomeEntity',
        type: 'belongs_to',
      });
      expect(instance.attributes.someEntityId).to.deep.equal({
        required: true,
        type: 'string',
        validate: instance.attributes.someEntityId.validate,
      });
      expect(instance.rawIndexes.belongs_to[0]).to.deep.equal({
        type: 'belongs_to',
        pk: { composite: ['someEntityId'] },
        sk: { composite: ['updatedAt'] },
      });
    });

    it('successfully adds a belongs_to reference which is not required', () => {
      const result = instance.addReference('belongs_to', 'someEntity', ['updatedAt'], { required: false });

      expect(result).to.equal(instance);
      expect(instance.references).to.be.an('array').with.length(1);
      expect(instance.references[0]).to.deep.equal({
        options: {
          required: false,
          sortKeys: ['updatedAt'],
        },
        target: 'someEntity',
        type: 'belongs_to',
      });
      expect(instance.attributes.someEntityId).to.deep.equal({
        required: false,
        type: 'string',
        validate: instance.attributes.someEntityId.validate,
      });
      expect(instance.rawIndexes.belongs_to[0]).to.deep.equal({
        type: 'belongs_to',
        pk: { composite: ['someEntityId'] },
        sk: { composite: ['updatedAt'] },
      });
    });
  });

  describe('validate, default, and set', () => {
    it('sets defaults for createdAt and updatedAt', () => {
      expect(isIsoDate(instance.attributes.createdAt.default())).to.be.true;
      expect(isIsoDate(instance.attributes.updatedAt.default())).to.be.true;
      expect(isIsoDate(instance.attributes.updatedAt.set())).to.be.true;
    });

    it('sets default for id attribute', () => {
      expect(uuidValidate(instance.attributes.mockModelId.default())).to.be.true;
    });

    it('validates id attribute', () => {
      expect(instance.attributes.mockModelId.validate('78fec9c7-2141-4600-b7b1-ea5c78752b91')).to.be.true;
      expect(instance.attributes.mockModelId.validate('invalid')).to.be.false;
    });

    it('validates foreign key attribute', () => {
      instance.addReference('belongs_to', 'someEntity');
      expect(instance.attributes.someEntityId.validate('78fec9c7-2141-4600-b7b1-ea5c78752b91')).to.be.true;
      expect(instance.attributes.someEntityId.validate('invalid')).to.be.false;
    });

    it('validates non-required foreign key attribute', () => {
      instance.addReference('belongs_to', 'someEntity', [], { required: false });
      expect(instance.attributes.someEntityId.required).to.be.false;
      expect(instance.attributes.someEntityId.validate()).to.be.true;
      expect(instance.attributes.someEntityId.validate('78fec9c7-2141-4600-b7b1-ea5c78752b91')).to.be.true;
      expect(instance.attributes.someEntityId.validate('invalid')).to.be.false;
    });
  });

  describe('build', () => {
    it('returns the built schema', () => {
      instance.addReference('belongs_to', 'Organization');
      instance.addReference('belongs_to', 'Site', ['someField'], { required: false });
      instance.addReference('has_many', 'Audits');
      instance.addAttribute('baseURL', {
        type: 'string',
        required: true,
        validate: () => true,
      });
      instance.addAllIndex(['baseURL']);
      instance.addIndex({ composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      instance.addIndex({ field: 'someField', composite: ['deliveryType'] }, { composite: ['updatedAt'] });

      const schema = instance.build();

      expect(schema).to.deep.equal({
        schemaVersion: 1,
        serviceName: 'SpaceCat',
        modelClass: MockModel,
        collectionClass: MockCollection,
        attributes: {
          mockModelId: {
            type: 'string',
            required: true,
            readOnly: true,
            validate: instance.attributes.mockModelId.validate,
            default: instance.attributes.mockModelId.default,
          },
          createdAt: {
            type: 'string',
            readOnly: true,
            required: true,
            default: instance.attributes.createdAt.default,
          },
          updatedAt: {
            type: 'string',
            required: true,
            readOnly: true,
            watch: '*',
            default: instance.attributes.updatedAt.default,
            set: instance.attributes.updatedAt.set,
          },
          organizationId: {
            type: 'string',
            required: true,
            validate: instance.attributes.organizationId.validate,
          },
          siteId: {
            type: 'string',
            required: false,
            validate: instance.attributes.siteId.validate,
          },
          baseURL: {
            type: 'string',
            required: true,
            validate: instance.attributes.baseURL.validate,
          },
        },
        indexes: {
          primary: {
            pk: { field: 'pk', composite: ['mockModelId'] },
            sk: { field: 'sk', composite: [] },
          },
          'spacecat-data-gsi1pk-gsi1sk': {
            index: 'spacecat-data-gsi1pk-gsi1sk',
            indexType: 'all',
            pk: { field: 'gsi1pk', template: 'ALL_MOCKMODELS' },
            sk: { field: 'gsi1sk', composite: ['baseURL'] },
          },
          'spacecat-data-gsi2pk-gsi2sk': {
            index: 'spacecat-data-gsi2pk-gsi2sk',
            indexType: 'belongs_to',
            pk: { composite: ['organizationId'], field: 'gsi2pk' },
            sk: { composite: ['updatedAt'], field: 'gsi2sk' },
          },
          'spacecat-data-gsi3pk-gsi3sk': {
            index: 'spacecat-data-gsi3pk-gsi3sk',
            indexType: 'belongs_to',
            pk: { composite: ['siteId'], field: 'gsi3pk' },
            sk: { composite: ['someField'], field: 'gsi3sk' },
          },
          'spacecat-data-gsi4pk-gsi4sk': {
            index: 'spacecat-data-gsi4pk-gsi4sk',
            indexType: 'other',
            pk: { composite: ['deliveryType'], field: 'gsi4pk' },
            sk: { composite: ['updatedAt'], field: 'gsi4sk' },
          },
          'spacecat-data-gsi5pk-gsi5sk': {
            index: 'spacecat-data-gsi5pk-gsi5sk',
            indexType: 'other',
            pk: { composite: ['deliveryType'], field: 'someField' },
            sk: { composite: ['updatedAt'], field: 'gsi5sk' },
          },
        },
        references: [
          {
            options: {
              required: true,
              sortKeys: [],
            },
            target: 'Organization',
            type: 'belongs_to',
          },
          {
            options: {
              required: false,
              sortKeys: ['someField'],
            },
            target: 'Site',
            type: 'belongs_to',
          },
          {
            options: {
              removeDependents: false,
              sortKeys: [],
            },
            target: 'Audits',
            type: 'has_many',
          },
        ],
        options: { allowRemove: true, allowUpdates: true },
      });
    });

    it('throws error if more than 5 indexes are added', () => {
      instance.addAllIndex(['baseURL']);
      instance.addIndex({ composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      instance.addIndex({ field: 'someField', composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      instance.addIndex({ field: 'someField', composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      instance.addIndex({ field: 'someField', composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      instance.addIndex({ field: 'someField', composite: ['deliveryType'] }, { composite: ['updatedAt'] });
      expect(() => instance.build()).to.throw(SchemaBuilderError, '[SpaceCat -> MockModel] Cannot have more than 5 indexes.');
    });
  });
});
