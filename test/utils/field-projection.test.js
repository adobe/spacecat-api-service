/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { expect } from 'chai';
import {
  parseFields,
  projectFields,
  hasMatchingFields,
  applyFieldProjection,
} from '../../src/utils/field-projection.js';

describe('field-projection', () => {
  describe('parseFields', () => {
    it('returns null when the param is absent or empty', () => {
      expect(parseFields(undefined)).to.be.null;
      expect(parseFields(null)).to.be.null;
      expect(parseFields('')).to.be.null;
      expect(parseFields('   ')).to.be.null;
      expect(parseFields(',,')).to.be.null;
    });

    it('splits, trims and drops empties', () => {
      expect(parseFields('id,baseURL,name')).to.deep.equal(['id', 'baseURL', 'name']);
      expect(parseFields(' id , baseURL ,, name ')).to.deep.equal(['id', 'baseURL', 'name']);
    });
  });

  describe('projectFields', () => {
    const obj = {
      id: '1', baseURL: 'https://x.com', name: 'X', config: { big: true },
    };

    it('returns the original object when fields is null', () => {
      expect(projectFields(obj, null)).to.equal(obj);
    });

    it('returns the original value when not an object', () => {
      expect(projectFields('nope', ['id'])).to.equal('nope');
    });

    it('projects only the requested keys', () => {
      expect(projectFields(obj, ['baseURL', 'name'])).to.deep.equal({
        id: '1', baseURL: 'https://x.com', name: 'X',
      });
    });

    it('always retains id even when not requested', () => {
      expect(projectFields(obj, ['name'])).to.deep.equal({ id: '1', name: 'X' });
    });

    it('ignores unknown fields', () => {
      expect(projectFields(obj, ['name', 'nope'])).to.deep.equal({ id: '1', name: 'X' });
    });

    it('omits id when the object has none', () => {
      expect(projectFields({ name: 'X', extra: 1 }, ['name'])).to.deep.equal({ name: 'X' });
    });
  });

  describe('hasMatchingFields', () => {
    const items = [{ id: '1', name: 'X' }, { id: '2', title: 'Y' }];

    it('is true when fields is null', () => {
      expect(hasMatchingFields(items, null)).to.be.true;
    });

    it('is true for an empty list (nothing to validate against)', () => {
      expect(hasMatchingFields([], ['nope'])).to.be.true;
    });

    it('is true when at least one field exists on any item', () => {
      expect(hasMatchingFields(items, ['title', 'nope'])).to.be.true;
    });

    it('is false when no field matches any item', () => {
      expect(hasMatchingFields(items, ['nope', 'missing'])).to.be.false;
    });
  });

  describe('applyFieldProjection', () => {
    const items = [
      { id: '1', baseURL: 'https://a.com', config: { a: 1 } },
      { id: '2', baseURL: 'https://b.com', config: { b: 2 } },
    ];

    it('returns the list unchanged when no param is provided', () => {
      const { list, error } = applyFieldProjection(items, undefined);
      expect(error).to.be.null;
      expect(list).to.equal(items);
    });

    it('projects every item to the requested fields', () => {
      const { list, error } = applyFieldProjection(items, 'baseURL');
      expect(error).to.be.null;
      expect(list).to.deep.equal([
        { id: '1', baseURL: 'https://a.com' },
        { id: '2', baseURL: 'https://b.com' },
      ]);
    });

    it('returns an error when no requested field matches', () => {
      const { list, error } = applyFieldProjection(items, 'nope,missing');
      expect(list).to.be.null;
      expect(error).to.equal('Invalid fields: nope, missing');
    });

    it('truncates the echoed field list when many fields are invalid', () => {
      const manyFields = Array.from({ length: 8 }, (_, i) => `nope${i}`).join(',');
      const { list, error } = applyFieldProjection(items, manyFields);
      expect(list).to.be.null;
      expect(error).to.equal('Invalid fields: nope0, nope1, nope2, nope3, nope4, ...');
    });

    it('returns an empty list, not an error, when items is empty regardless of fields', () => {
      const { list, error } = applyFieldProjection([], 'nope');
      expect(error).to.be.null;
      expect(list).to.deep.equal([]);
    });

    it('rejects a fields param exceeding the max length', () => {
      const longParam = `id${','.repeat(1000)}`;
      const { list, error } = applyFieldProjection(items, longParam);
      expect(list).to.be.null;
      expect(error).to.equal('fields parameter exceeds maximum length of 1000 characters');
    });

    it('rejects more than the max number of fields', () => {
      const tooManyFields = Array.from({ length: 51 }, (_, i) => `f${i}`).join(',');
      const { list, error } = applyFieldProjection(items, tooManyFields);
      expect(list).to.be.null;
      expect(error).to.equal('Too many fields requested: 51 (max 50)');
    });

    it('accepts exactly the max number of fields', () => {
      const maxFields = Array(50).fill('id').join(',');
      const { list, error } = applyFieldProjection(items, maxFields);
      expect(error).to.be.null;
      expect(list).to.deep.equal([{ id: '1' }, { id: '2' }]);
    });

    it('handles a non-array input gracefully', () => {
      const { list, error } = applyFieldProjection(null, 'id');
      expect(error).to.be.null;
      expect(list).to.be.null;
    });
  });
});
