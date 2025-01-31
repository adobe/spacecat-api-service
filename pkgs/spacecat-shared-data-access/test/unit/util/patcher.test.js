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
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';

import Patcher from '../../../src/util/patcher.js';
import Schema from '../../../src/models/base/schema.js';
import BaseModel from '../../../src/models/base/base.model.js';
import BaseCollection from '../../../src/models/base/base.collection.js';

chaiUse(chaiAsPromised);

const MockModel = class MockEntityModel extends BaseModel {};
const MockCollection = class MockEntityCollection extends BaseCollection {};

describe('Patcher', () => {
  let patcher;
  let mockEntity;
  let mockRecord;

  beforeEach(() => {
    mockEntity = {
      model: {
        entity: 'MockModel',
        schema: {
          attributes: {
            name: { type: 'string', name: 'name', get: (value) => value },
            age: { type: 'number', name: 'age', get: (value) => value },
            tags: {
              type: 'set', name: 'tags', items: { type: 'string' }, get: (value) => value,
            },
            status: {
              type: 'enum', name: 'status', enumArray: ['active', 'inactive'], get: (value) => value,
            },
            referenceId: { type: 'string', name: 'referenceId', get: (value) => value },
            metadata: { type: 'map', name: 'metadata', get: (value) => value },
            profile: { type: 'any', name: 'profile', get: (value) => value },
            nickNames: {
              type: 'list', name: 'nickNames', items: { type: 'string' }, get: (value) => value,
            },
            settings: {
              type: 'any', name: 'settings', required: true, get: (value) => value,
            },
            isActive: { type: 'boolean', name: 'isActive', get: (value) => value },
          },
        },
        indexes: {
          primaryIndex: {
            pk: { facets: ['testEntityId'] },
            sk: { facets: ['name', 'age'] },
          },
        },
      },
      patch: sinon.stub().returns({
        composite: sinon.stub().returnsThis(),
        set: sinon.stub().returnsThis(),
        go: sinon.stub().resolves(),
      }),
    };

    mockRecord = {
      testEntityId: '123',
      name: 'Test',
      age: 25,
      tags: ['tag1', 'tag2'],
      status: 'active',
      referenceId: '456',
    };

    const schema = new Schema(
      MockModel,
      MockCollection,
      {
        serviceName: 'service',
        schemaVersion: 1,
        attributes: mockEntity.model.schema.attributes,
        indexes: mockEntity.model.indexes,
        model: mockEntity.model,
        references: [],
        options: { allowRemove: true, allowUpdates: true },
      },
    );

    patcher = new Patcher(mockEntity, schema, mockRecord);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('patches a string value', () => {
    patcher.patchValue('name', 'UpdatedName');
    expect(mockEntity.patch().set.calledWith({ name: 'UpdatedName' })).to.be.true;
    expect(mockRecord.name).to.equal('UpdatedName');
  });

  it('throws error if schema prhibits updates', () => {
    patcher.schema.options.allowUpdates = false;
    expect(() => patcher.patchValue('name', 'UpdatedName'))
      .to.throw('Updates prohibited by schema for MockEntityModel.');
  });

  it('throws error for read-only property', () => {
    mockEntity.model.schema.attributes.name.readOnly = true;
    expect(() => patcher.patchValue('name', 'NewValue'))
      .to.throw('The property name is read-only and cannot be updated.');
  });

  it('validates an enum attribute', () => {
    patcher.patchValue('status', 'inactive');
    expect(mockRecord.status).to.equal('inactive');
  });

  it('throws error for unsupported enum value', () => {
    expect(() => patcher.patchValue('status', 'unknown'))
      .to.throw('Validation failed in mockEntityModel: status must be one of active,inactive');
  });

  it('patches a reference id with proper validation', () => {
    patcher.patchValue('referenceId', 'ef39921f-9a02-41db-b491-02c98987d956', true);
    expect(mockRecord.referenceId).to.equal('ef39921f-9a02-41db-b491-02c98987d956');
  });

  it('throws error for non-existent property', () => {
    expect(() => patcher.patchValue('nonExistent', 'value'))
      .to.throw('Property nonExistent does not exist on entity mockEntityModel.');
  });

  it('tracks updates', () => {
    patcher.patchValue('name', 'UpdatedName');

    expect(patcher.hasUpdates()).to.be.true;
    expect(patcher.getUpdates().name.previous).to.deep.equal('Test');
    expect(patcher.getUpdates().name.current).to.deep.equal('UpdatedName');
  });

  it('saves the record', async () => {
    patcher.patchValue('name', 'UpdatedName');

    await patcher.save();

    expect(mockEntity.patch().go.calledOnce).to.be.true;
    expect(isIsoDate(mockRecord.updatedAt)).to.be.true;
  });

  it('throws error when saving with updates prohibited by schema', async () => {
    patcher.schema.options.allowUpdates = false;

    expect(patcher.save()).to.be.rejectedWith('Updates prohibited by schema for MockModel.');
  });

  it('does not save if there are no updates', async () => {
    await patcher.save();
    expect(mockEntity.patch().go.notCalled).to.be.true;
  });

  it('throws error if attribute type is unsupported', () => {
    mockEntity.model.schema.attributes.invalidType = { type: 'unsupported' };
    expect(() => patcher.patchValue('invalidType', 'value'))
      .to.throw('Unsupported type for property invalidType');
  });

  it('validates and patch a set attribute', () => {
    patcher.patchValue('tags', ['tag3', 'tag4']);
    expect(mockRecord.tags).to.deep.equal(['tag3', 'tag4']);
  });

  it('throws error for invalid set attribute', () => {
    expect(() => patcher.patchValue('tags', ['tag1', 123]))
      .to.throw('Validation failed in mockEntityModel: tags must contain items of type string');
  });

  it('validates and patches a number attribute', () => {
    patcher.patchValue('age', 30);
    expect(mockRecord.age).to.equal(30);
  });

  it('throws error for invalid number attribute', () => {
    expect(() => patcher.patchValue('age', 'notANumber'))
      .to.throw('Validation failed in mockEntityModel: age must be a number');
  });

  it('validates and patch a map attribute', () => {
    patcher.patchValue('metadata', { newKey: 'newValue' });
    expect(mockRecord.metadata).to.deep.equal({ newKey: 'newValue' });
  });

  it('throws error for invalid map attribute', () => {
    expect(() => patcher.patchValue('metadata', 'notAMap'))
      .to.throw('Validation failed in mockEntityModel: metadata must be an object');
  });

  it('validates and patches an any attribute', () => {
    patcher.patchValue('profile', { pic: './ref' });
    expect(mockRecord.profile).to.eql({ pic: './ref' });
  });

  it('throws error for undefined any attribute', () => {
    expect(() => patcher.patchValue('settings', undefined))
      .to.throw('Validation failed in mockEntityModel: settings is required');
  });

  it('throws error for null any attribute', () => {
    expect(() => patcher.patchValue('settings', null))
      .to.throw('Validation failed in mockEntityModel: settings is required');
  });

  it('validates and patches a boolean attribute', () => {
    patcher.patchValue('isActive', true);
    expect(mockRecord.isActive).to.be.true;
  });

  it('validates and patches a list attribute', () => {
    patcher.patchValue('nickNames', ['name1', 'name2']);
    expect(mockRecord.nickNames).to.deep.equal(['name1', 'name2']);
  });

  it('throws error for invalid list attribute', () => {
    expect(() => patcher.patchValue('nickNames', 'notAList'))
      .to.throw('Validation failed in mockEntityModel: nickNames must be an array');
  });

  it('throws error for invalid list attribute items', () => {
    expect(() => patcher.patchValue('nickNames', ['name1', 123]))
      .to.throw('Validation failed in mockEntityModel: nickNames must contain items of type string');
  });
});
