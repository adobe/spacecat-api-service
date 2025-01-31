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

import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';

import { stub } from 'sinon';

import Reference from '../../../../src/models/base/reference.js';
import ReferenceError from '../../../../src/errors/reference.error.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('Reference', () => {
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      debug: stub(),
      error: stub(),
      warn: stub(),
    };
  });

  describe('constructor', () => {
    it('creates a new reference with the correct properties', () => {
      const reference = new Reference('has_many', 'Test');

      expect(reference).to.be.an('object');
      expect(reference).to.deep.equal({
        options: {},
        target: 'Test',
        type: 'has_many',
      });
    });

    it('creates a new reference from JSON', () => {
      const reference = Reference.fromJSON({
        options: {},
        target: 'Test',
        type: 'has_many',
      });

      expect(reference).to.be.an('object');
      expect(reference).to.deep.equal({
        options: {},
        target: 'Test',
        type: 'has_many',
      });
    });

    it('throws an error for an invalid type', () => {
      expect(() => new Reference('invalid', 'Test'))
        .to.throw(ReferenceError, 'Invalid reference type: invalid');
    });

    it('throws an error for an invalid target', () => {
      expect(() => new Reference('has_many', ''))
        .to.throw(ReferenceError, 'Invalid target');
    });
  });

  describe('isValidType', () => {
    it('returns true for a valid type', () => {
      expect(Reference.isValidType('has_many')).to.be.true;
    });

    it('returns false for an invalid type', () => {
      expect(Reference.isValidType('invalid')).to.be.false;
    });
  });

  describe('accessors', () => {
    it('returns the target', () => {
      const reference = new Reference('has_many', 'Test');

      expect(reference.getTarget()).to.equal('Test');
    });

    it('returns the type', () => {
      const reference = new Reference('has_many', 'Test');

      expect(reference.getType()).to.equal('has_many');
    });

    it('returns true for removeDependents', () => {
      const reference = new Reference('has_many', 'Test', { removeDependents: true });

      expect(reference.isRemoveDependents()).to.be.true;
    });

    it('returns false for removeDependents', () => {
      const reference = new Reference('has_many', 'Test', { removeDependents: false });

      expect(reference.isRemoveDependents()).to.be.false;
    });
  });

  describe('toAccessorConfigs', () => {
    it('throws an error for an invalid registry', () => {
      const reference = new Reference('has_many', 'Test');

      expect(() => reference.toAccessorConfigs(null, { }))
        .to.throw(ReferenceError, '[has_many -> Test] Invalid registry');
    });

    it('throws an error for an invalid entity', () => {
      const reference = new Reference('has_many', 'Test');

      expect(() => reference.toAccessorConfigs({ a: 1 }, null))
        .to.throw(ReferenceError, '[has_many -> Test] Invalid entity');
    });

    it('returns accessor configs for has_many', () => {
      const schema = {
        getReferenceByTypeAndTarget: stub().returns(new Reference('belongs_to', 'Test')),
        getModelName: () => 'Test',
      };
      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema,
        }),
      };
      const reference = new Reference('has_many', 'Test');
      const entity = {
        entityName: 'Test',
        getId: () => '123',
        schema,
      };

      const accessorConfigs = reference.toAccessorConfigs(registry, entity);

      expect(accessorConfigs).to.be.an('array');
      expect(accessorConfigs).to.have.lengthOf(1);
      expect(accessorConfigs[0]).to.deep.equal({
        all: true,
        collection: {
          name: 'TestCollection',
          schema,
        },
        context: {
          entityName: 'Test',
          getId: entity.getId,
          schema,
        },
        foreignKey: {
          name: 'testId',
          value: '123',
        },
        name: 'getTests',
        requiredKeys: [],
      });
    });

    it('returns accessor configs for has_one', () => {
      const schema = {
        getReferenceByTypeAndTarget: stub().returns(new Reference('belongs_to', 'Test')),
        getModelName: () => 'Test',
      };
      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema,
        }),
      };
      const reference = new Reference('has_one', 'Test');
      const entity = {
        entityName: 'Test',
        getId: () => '123',
        schema,
      };

      const accessorConfigs = reference.toAccessorConfigs(registry, entity);

      expect(accessorConfigs).to.be.an('array');
      expect(accessorConfigs).to.have.lengthOf(1);
      expect(accessorConfigs[0]).to.deep.equal({
        collection: {
          name: 'TestCollection',
          schema,
        },
        context: {
          entityName: 'Test',
          getId: entity.getId,
          schema,
        },
        foreignKey: {
          name: 'testId',
          value: '123',
        },
        name: 'getTest',
        requiredKeys: [],
      });
    });

    it('returns accessor configs for belongs_to', () => {
      const schema = {
        getReferenceByTypeAndTarget: stub().returns(new Reference('belongs_to', 'Test')),
        getModelName: () => 'Test',
      };
      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema,
        }),
      };
      const reference = new Reference('belongs_to', 'Test');
      const entity = {
        entityName: 'Test',
        record: { testId: '123' },
        schema,
      };

      const accessorConfigs = reference.toAccessorConfigs(registry, entity);

      expect(accessorConfigs).to.be.an('array');
      expect(accessorConfigs).to.have.lengthOf(1);
      expect(accessorConfigs[0]).to.deep.equal({
        collection: {
          name: 'TestCollection',
          schema,
        },
        context: {
          entityName: 'Test',
          record: { testId: '123' },
          schema,
        },
        foreignKey: {
          name: 'testId',
          value: '123',
        },
        byId: true,
        name: 'getTest',
        requiredKeys: [],
      });
    });

    it('logs warning for missing reciprocal reference', () => {
      const schema = {
        getReferenceByTypeAndTarget: stub().returns(null),
        getModelName: () => 'Test',
      };
      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema,
        }),
      };
      const reference = new Reference('has_many', 'Test');
      const entity = {
        entityName: 'Test',
        getId: () => '123',
        schema,
      };

      reference.toAccessorConfigs(registry, entity);

      expect(mockLogger.warn).to.have.been.calledOnceWithExactly('Reciprocal reference not found for Test to Test');
    });

    it('logs debug for no sort keys defined', () => {
      const schema = {
        getReferenceByTypeAndTarget: stub().returns(new Reference('belongs_to', 'Test')),
        getModelName: () => 'Test',
      };
      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema,
        }),
      };
      const reference = new Reference('has_many', 'Test');
      const entity = {
        entityName: 'Test',
        getId: () => '123',
        schema,
      };

      reference.toAccessorConfigs(registry, entity);

      expect(mockLogger.debug).to.have.been.calledOnceWithExactly('No sort keys defined for Test to Test');
    });

    it('throws an error for an invalid type', () => {
      const reference = new Reference('has_many', 'Test');
      reference.type = 'invalid';

      const registry = {
        log: mockLogger,
        getCollection: stub().returns({
          name: 'TestCollection',
          schema: {},
        }),
      };

      expect(() => reference.toAccessorConfigs(registry, { a: 1 }))
        .to.throw(ReferenceError, '[invalid -> Test] Unsupported reference type: invalid');
    });
  });
});
