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
  applyFilters,
  applyInclusions,
  applyExclusions,
  applyGroups,
  applyMappings,
  applySort,
} from '../../../src/controllers/llmo/llmo-utils.js';

describe('llmo-utils', () => {
  describe('applyFilters', () => {
    it('filters sheet data by exact case-insensitive field match', () => {
      const raw = {
        ':type': 'sheet',
        data: [
          { name: 'Alice', role: 'admin' },
          { name: 'Bob', role: 'user' },
        ],
      };
      const result = applyFilters(raw, { role: 'ADMIN' });
      expect(result.data).to.deep.equal([{ name: 'Alice', role: 'admin' }]);
    });

    it('excludes items with null/undefined field values', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ name: 'Alice', role: null }, { name: 'Bob', role: 'user' }],
      };
      const result = applyFilters(raw, { role: 'user' });
      expect(result.data).to.have.length(1);
      expect(result.data[0].name).to.equal('Bob');
    });

    it('filters multi-sheet data by field match', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ x: 'a' }, { x: 'b' }] },
        sheet2: { data: [{ x: 'a' }, { x: 'c' }] },
      };
      const result = applyFilters(raw, { x: 'a' });
      expect(result.sheet1.data).to.have.length(1);
      expect(result.sheet2.data).to.have.length(1);
    });

    it('skips non-data keys in multi-sheet', () => {
      const raw = {
        ':type': 'multi-sheet',
        noData: { other: 'field' },
      };
      const result = applyFilters(raw, { x: 'a' });
      expect(result[':type']).to.equal('multi-sheet');
    });

    it('returns data unchanged for unknown type', () => {
      const raw = { ':type': 'other', data: [{ x: 1 }] };
      const result = applyFilters(raw, { x: 1 });
      expect(result).to.deep.equal(raw);
    });
  });

  describe('applyInclusions', () => {
    it('retains only the specified fields in sheet data', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ a: 1, b: 2, c: 3 }],
      };
      const result = applyInclusions(raw, ['a', 'c']);
      expect(result.data[0]).to.deep.equal({ a: 1, c: 3 });
      expect(result.data[0]).not.to.have.property('b');
    });

    it('omits fields with falsy values', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ a: 0, b: '', c: 'keep' }],
      };
      const result = applyInclusions(raw, ['a', 'b', 'c']);
      expect(result.data[0]).to.deep.equal({ c: 'keep' });
    });

    it('applies inclusions to multi-sheet data', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ a: 1, b: 2 }] },
      };
      const result = applyInclusions(raw, ['a']);
      expect(result.sheet1.data[0]).to.deep.equal({ a: 1 });
    });
  });

  describe('applyExclusions', () => {
    it('removes specified fields from sheet data', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ a: 1, b: 2, c: 3 }],
      };
      const result = applyExclusions(raw, ['b']);
      expect(result.data[0]).to.deep.equal({ a: 1, c: 3 });
    });

    it('removes specified fields from multi-sheet data', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ a: 1, secret: 'x' }] },
        sheet2: { data: [{ a: 2, secret: 'y' }] },
      };
      const result = applyExclusions(raw, ['secret']);
      expect(result.sheet1.data[0]).not.to.have.property('secret');
      expect(result.sheet2.data[0]).not.to.have.property('secret');
      expect(result.sheet1.data[0].a).to.equal(1);
    });

    it('does not mutate the original data', () => {
      const raw = { ':type': 'sheet', data: [{ a: 1, b: 2 }] };
      applyExclusions(raw, ['b']);
      expect(raw.data[0]).to.have.property('b');
    });
  });

  describe('applyGroups', () => {
    it('groups sheet data by specified attribute', () => {
      const raw = {
        ':type': 'sheet',
        data: [
          { region: 'us', value: 1 },
          { region: 'us', value: 2 },
          { region: 'eu', value: 3 },
        ],
      };
      const result = applyGroups(raw, ['region']);
      expect(result.data).to.have.length(2);
      const us = result.data.find((g) => g.region === 'us');
      expect(us.records).to.have.length(2);
      expect(us.records[0]).not.to.have.property('region');
    });

    it('groups multi-sheet data by attribute', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { cat: 'a', v: 1 },
            { cat: 'a', v: 2 },
            { cat: 'b', v: 3 },
          ],
        },
      };
      const result = applyGroups(raw, ['cat']);
      expect(result.sheet1.data).to.have.length(2);
    });

    it('handles null grouping attribute values', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ region: null, v: 1 }, { region: 'us', v: 2 }],
      };
      const result = applyGroups(raw, ['region']);
      expect(result.data).to.have.length(2);
      const nullGroup = result.data.find((g) => g.region === null);
      expect(nullGroup).to.exist;
    });
  });

  describe('applyMappings', () => {
    it('renames fields in data according to mapping config', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ old_name: 'Alice', age: 30 }] },
      };
      const mappingConfig = { mappings: { sheet1: { old_name: 'name' } } };
      const result = applyMappings(raw, mappingConfig);
      expect(result.sheet1.data[0]).to.have.property('name', 'Alice');
      expect(result.sheet1.data[0]).not.to.have.property('old_name');
    });

    it('skips fields with falsy values', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ old_name: '', age: 30 }] },
      };
      const mappingConfig = { mappings: { sheet1: { old_name: 'name' } } };
      const result = applyMappings(raw, mappingConfig);
      expect(result.sheet1.data[0]).not.to.have.property('name');
      expect(result.sheet1.data[0]).to.have.property('old_name', '');
    });

    it('skips keys without mappings config', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ a: 1 }] },
      };
      const result = applyMappings(raw, { mappings: {} });
      expect(result.sheet1.data[0]).to.deep.equal({ a: 1 });
    });
  });

  describe('applySort', () => {
    it('sorts sheet data ascending by numeric field', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ v: 3 }, { v: 1 }, { v: 2 }],
      };
      const result = applySort(raw, { field: 'v', order: 'asc' });
      expect(result.data.map((r) => r.v)).to.deep.equal([1, 2, 3]);
    });

    it('sorts sheet data descending by numeric field', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ v: 1 }, { v: 3 }, { v: 2 }],
      };
      const result = applySort(raw, { field: 'v', order: 'desc' });
      expect(result.data.map((r) => r.v)).to.deep.equal([3, 2, 1]);
    });

    it('sorts by string field when non-numeric', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ name: 'charlie' }, { name: 'alice' }, { name: 'bob' }],
      };
      const result = applySort(raw, { field: 'name', order: 'asc' });
      expect(result.data.map((r) => r.name)).to.deep.equal(['alice', 'bob', 'charlie']);
    });

    it('sorts descending by string field', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ name: 'alice' }, { name: 'charlie' }, { name: 'bob' }],
      };
      const result = applySort(raw, { field: 'name', order: 'desc' });
      expect(result.data.map((r) => r.name)).to.deep.equal(['charlie', 'bob', 'alice']);
    });

    it('pushes null values to the end', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ v: null }, { v: 1 }, { v: null }],
      };
      const result = applySort(raw, { field: 'v', order: 'asc' });
      expect(result.data[2].v).to.equal(null);
    });

    it('handles both null values in comparison', () => {
      const raw = {
        ':type': 'sheet',
        data: [{ v: null }, { v: null }],
      };
      const result = applySort(raw, { field: 'v', order: 'asc' });
      expect(result.data).to.have.length(2);
    });

    it('sorts multi-sheet data', () => {
      const raw = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ v: 3 }, { v: 1 }] },
      };
      const result = applySort(raw, { field: 'v', order: 'asc' });
      expect(result.sheet1.data[0].v).to.equal(1);
    });
  });
});
