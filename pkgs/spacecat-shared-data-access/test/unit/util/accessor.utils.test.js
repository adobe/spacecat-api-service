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
import sinon, { stub } from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';

import { createAccessor } from '../../../src/util/accessor.utils.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('Accessor Utils', () => { /* eslint-disable no-underscore-dangle */
  let mockLogger;
  let mockContext;
  let mockCollection;

  beforeEach(() => {
    mockLogger = {
      debug: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    };

    mockContext = { log: mockLogger };

    mockCollection = {
      allByIndexKeys: stub().returns(Promise.resolve([{}])),
      findById: stub().returns(Promise.resolve({})),
      findByIndexKeys: stub().returns(Promise.resolve({})),
      schema: {
        getAttribute: stub().returns({ type: 'string' }),
      },
    };
  });

  describe('createAccessor', () => {
    it('throws an error if no config is provided', () => {
      expect(() => createAccessor()).to.throw('Config is required');
      expect(() => createAccessor([])).to.throw('Config is required');
    });

    it('throws an error if collection is not provided', () => {
      expect(() => createAccessor({ a: 1 })).to.throw('Collection is required');
    });

    it('throws an error if context is not provided', () => {
      expect(() => createAccessor({ collection: { a: 1 } })).to.throw('Context is required');
    });

    it('throws an error if name is not provided', () => {
      expect(() => createAccessor({ collection: { a: 1 }, context: { a: 1 } })).to.throw('Name is required');
    });

    it('throws and error if requiredKeys is not an array', () => {
      expect(() => createAccessor({
        collection: { a: 1 }, context: { a: 1 }, name: 'test', requiredKeys: 'test',
      })).to.throw('Required keys must be an array');
    });

    it('creates an accessor from config', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: ['test'],
      };

      createAccessor(config);

      expect(mockContext.test).to.be.a('function');
      expect(mockContext.test()).to.be.an('Promise');
      expect(mockContext._accessorCache).to.deep.equal({});
    });

    it('does not create an accessor cache if existing', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: ['test'],
      };
      mockContext._accessorCache = { a: 1 };

      createAccessor(config);

      expect(mockContext._accessorCache).to.deep.equal({ a: 1 });
    });

    it('does not create accessor if context already has a function with the same name', async () => {
      const config = {
        collection: mockCollection,
        context: { test: () => {} },
        name: 'test',
        requiredKeys: ['test'],
      };

      createAccessor(config);

      expect(mockCollection.schema.getAttribute).to.not.have.been.called;
      expect(mockCollection.findByIndexKeys).to.not.have.been.called;
    });
  });

  describe('call accessor', () => {
    it('calling accessor calls findByIndexKeys', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: ['test'],
      };

      createAccessor(config);

      await expect(mockContext.test('test')).to.be.eventually.deep.equal({});
      expect(mockCollection.schema.getAttribute).to.have.been.calledOnceWith('test');
      expect(mockCollection.findByIndexKeys).to.have.been.calledOnceWith({ test: 'test' });
    });

    it('calling accessor calls allByIndexKeys', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: ['test'],
        all: true,
      };

      createAccessor(config);

      await expect(mockContext.test('test')).to.be.eventually.deep.equal([{}]);
      expect(mockCollection.schema.getAttribute).to.have.been.calledOnceWith('test');
      expect(mockCollection.allByIndexKeys).to.have.been.calledOnceWith({ test: 'test' });
    });

    it('calling accessor calls findBYId', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        foreignKey: { name: 'test', value: 'test' },
        name: 'test',
        requiredKeys: ['test'],
        byId: true,
      };

      createAccessor(config);

      await expect(mockContext.test('test')).to.be.eventually.deep.equal({});
      expect(mockCollection.schema.getAttribute).to.not.have.been.called;
      expect(mockCollection.findById).to.have.been.calledOnceWith('test');
    });

    it('returns null when calling accessor byId with no value', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        foreignKey: { name: 'test' },
        name: 'test',
        requiredKeys: ['test'],
        byId: true,
      };

      createAccessor(config);

      await expect(mockContext.test('test')).to.be.eventually.null;
      expect(mockCollection.schema.getAttribute).to.not.have.been.called;
      expect(mockCollection.findById).to.not.have.been.called;
    });

    it('returns cached result if repeatedly called without args', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: [],
      };

      createAccessor(config);

      expect(mockContext._accessorCache).to.deep.equal({});

      await expect(mockContext.test()).to.be.eventually.deep.equal({});

      expect(mockContext._accessorCache).to.deep.equal({ 'test:_': {} });

      await expect(mockContext.test()).to.be.eventually.deep.equal({});
      expect(mockCollection.schema.getAttribute).to.not.have.been.called;
      expect(mockCollection.findByIndexKeys).to.have.been.calledOnceWith({});
    });

    it('returns cached result if repeatedly called with same args', async () => {
      const config = {
        collection: mockCollection,
        context: mockContext,
        name: 'test',
        requiredKeys: ['test'],
      };

      createAccessor(config);

      expect(mockContext._accessorCache).to.deep.equal({});

      await expect(mockContext.test('test')).to.be.eventually.deep.equal({});

      expect(mockContext._accessorCache).to.deep.equal({ 'test:["test"]': {} });

      await expect(mockContext.test('test')).to.be.eventually.deep.equal({});
      expect(mockCollection.schema.getAttribute).to.have.been.calledOnceWith('test');
      expect(mockCollection.findByIndexKeys).to.have.been.calledOnceWith({ test: 'test' });
    });
  });
});
