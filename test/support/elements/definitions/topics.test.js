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
  buildTopicsPayload,
  transformTopicsForFilterDimensions,
  transformCategoriesToFilterDimensions,
  transformIntentsToFilterDimensions,
  transformOriginsToFilterDimensions,
  transformOtherTagsForFilterDimensions,
} from '../../../../src/support/elements/definitions/topics.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

// Mirrors the fixed keys elements-service.js's `getUrlInspectorFilterDimensions`
// builds `result` with, plus the JS-unsafe names it also guards against.
const RESERVED_RESULT_KEYS = [
  'brands', 'regions', 'topics', 'categories', 'page_intents', 'origins', 'tags',
  '__proto__', 'constructor', 'prototype',
];

const RAW_MIXED = {
  blocks: {
    value: [
      { value: 'topic:SEO' },
      { value: 'topic:AI' },
      { value: 'category:Firefly' },
      { value: 'category:Experience Cloud' },
      { value: 'category:Modular & Configurable Sofas__Compact Shippable Furniture' },
      { value: 'topic:Furniture__Compact Shippable Furniture' },
      { value: 'intent:Informational' },
      { value: 'intent:Transactional' },
      { value: 'source:organic' },
      { value: 'source:paid' },
    ],
  },
};

describe('topics definitions', () => {
  describe('buildTopicsPayload', () => {
    it('uses the default model when no params are provided', () => {
      const payload = buildTopicsPayload();
      expect(payload.filters.advanced.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('uses the default model when model is not in ELEMENT_MODELS', () => {
      const payload = buildTopicsPayload({ model: 'unknown-model' });
      expect(payload.filters.advanced.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('uses the provided model when it is valid', () => {
      const payload = buildTopicsPayload({ model: 'perplexity' });
      expect(payload.filters.advanced.filters[0].val).to.equal('perplexity');
    });

    it('translates a SpaceCat/UI platform code to the Semrush model', () => {
      const payload = buildTopicsPayload({ model: 'gemini' });
      expect(payload.filters.advanced.filters[0].val).to.equal('gemini-2.5-flash');
    });

    it('accepts the platform alias and translates it', () => {
      const payload = buildTopicsPayload({ platform: 'openai' });
      expect(payload.filters.advanced.filters[0].val).to.equal('gpt-5');
    });

    it('sets comparison_data_formatting to union', () => {
      const payload = buildTopicsPayload();
      expect(payload.comparison_data_formatting).to.equal('union');
    });

    it('does not include project_id when projectId is not provided', () => {
      const payload = buildTopicsPayload();
      expect(payload).to.not.have.property('project_id');
    });

    it('includes project_id when projectId is provided', () => {
      const payload = buildTopicsPayload({ projectId: 'proj-uuid-123' });
      expect(payload.project_id).to.equal('proj-uuid-123');
    });

    it('does not include project_id when projectId is an empty string', () => {
      const payload = buildTopicsPayload({ projectId: '' });
      expect(payload).to.not.have.property('project_id');
    });

    it('uses AND operator in the advanced filter', () => {
      const payload = buildTopicsPayload();
      expect(payload.filters.advanced.op).to.equal('and');
    });

    it('filters on CBF_model column', () => {
      const payload = buildTopicsPayload();
      expect(payload.filters.advanced.filters[0].col).to.equal('CBF_model');
    });
  });

  describe('transformTopicsForFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformTopicsForFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns only topic:-prefixed entries', () => {
      const result = transformTopicsForFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'topic:SEO', label: 'SEO' },
        { id: 'topic:AI', label: 'AI' },
        {
          id: 'topic:Furniture__Compact Shippable Furniture',
          label: 'Compact Shippable Furniture',
          parent_id: 'topic:Furniture',
          parent_label: 'Furniture',
        },
      ]);
    });

    it('adds parent_id/parent_label when the value contains a double underscore', () => {
      const raw = { blocks: { value: [{ value: 'topic:Furniture__Sofas' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'topic:Furniture__Sofas',
        label: 'Sofas',
        parent_id: 'topic:Furniture',
        parent_label: 'Furniture',
      });
    });

    it('splits only on the first double underscore', () => {
      const raw = { blocks: { value: [{ value: 'topic:A__B__C' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'topic:A__B__C',
        label: 'B__C',
        parent_id: 'topic:A',
        parent_label: 'A',
      });
    });

    it('sets id to the original tag value (including prefix) for each entry', () => {
      const raw = { blocks: { value: [{ value: 'topic:SEO' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item.id).to.equal('topic:SEO');
    });

    it('strips the topic: prefix from the label', () => {
      const raw = { blocks: { value: [{ value: 'topic:Machine Learning' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item.label).to.equal('Machine Learning');
    });

    it('excludes non-topic entries', () => {
      const raw = { blocks: { value: [{ value: 'category:Firefly' }, { value: 'topic:SEO' }] } };
      const result = transformTopicsForFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('SEO');
    });
  });

  describe('transformCategoriesToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformCategoriesToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns only category:-prefixed entries', () => {
      const result = transformCategoriesToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'category:Firefly', label: 'Firefly' },
        { id: 'category:Experience Cloud', label: 'Experience Cloud' },
        {
          id: 'category:Modular & Configurable Sofas__Compact Shippable Furniture',
          label: 'Compact Shippable Furniture',
          parent_id: 'category:Modular & Configurable Sofas',
          parent_label: 'Modular & Configurable Sofas',
        },
      ]);
    });

    it('adds parent_id/parent_label when the value contains a double underscore', () => {
      const raw = { blocks: { value: [{ value: 'category:Sofas__Modular Sofas' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category:Sofas__Modular Sofas',
        label: 'Modular Sofas',
        parent_id: 'category:Sofas',
        parent_label: 'Sofas',
      });
    });

    it('splits only on the first double underscore', () => {
      const raw = { blocks: { value: [{ value: 'category:A__B__C' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category:A__B__C',
        label: 'B__C',
        parent_id: 'category:A',
        parent_label: 'A',
      });
    });

    it('sets id to the original tag value (including prefix) for each entry', () => {
      const raw = { blocks: { value: [{ value: 'category:Creative' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item.id).to.equal('category:Creative');
    });

    it('sets parent_id to the prefix plus the parent label', () => {
      const raw = {
        blocks: {
          value: [{ value: 'category:Living Room Furniture Retail__Living Room Furniture and Sofas' }],
        },
      };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category:Living Room Furniture Retail__Living Room Furniture and Sofas',
        label: 'Living Room Furniture and Sofas',
        parent_id: 'category:Living Room Furniture Retail',
        parent_label: 'Living Room Furniture Retail',
      });
    });

    it('strips the category: prefix from the label', () => {
      const raw = { blocks: { value: [{ value: 'category:Creative Cloud' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item.label).to.equal('Creative Cloud');
    });

    it('excludes non-category entries', () => {
      const raw = { blocks: { value: [{ value: 'topic:SEO' }, { value: 'category:AI' }] } };
      const result = transformCategoriesToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('AI');
    });
  });

  describe('transformIntentsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformIntentsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns only intent:-prefixed entries', () => {
      const result = transformIntentsToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'intent:Informational', label: 'Informational' },
        { id: 'intent:Transactional', label: 'Transactional' },
      ]);
    });

    it('sets id to the original tag value (including prefix) and preserves original casing in label', () => {
      const raw = { blocks: { value: [{ value: 'intent:informational' }] } };
      const [item] = transformIntentsToFilterDimensions(raw);
      expect(item.id).to.equal('intent:informational');
      expect(item.label).to.equal('informational');
    });

    it('excludes non-intent entries', () => {
      const raw = { blocks: { value: [{ value: 'category:AI' }, { value: 'intent:Buy' }] } };
      const result = transformIntentsToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('Buy');
    });
  });

  describe('transformOriginsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformOriginsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns only source:-prefixed entries', () => {
      const result = transformOriginsToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'source:organic', label: 'organic' },
        { id: 'source:paid', label: 'paid' },
      ]);
    });

    it('sets id to the original tag value (including prefix) and label to the stripped value', () => {
      const raw = { blocks: { value: [{ value: 'source:direct' }] } };
      const [item] = transformOriginsToFilterDimensions(raw);
      expect(item.id).to.equal('source:direct');
      expect(item.label).to.equal('direct');
    });

    it('excludes non-source entries', () => {
      const raw = { blocks: { value: [{ value: 'topic:SEO' }, { value: 'source:organic' }] } };
      const result = transformOriginsToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('source:organic');
    });
  });

  describe('transformOtherTagsForFilterDimensions', () => {
    it('returns only an empty tags array when raw is null', () => {
      expect(transformOtherTagsForFilterDimensions(null)).to.deep.equal({ tags: [] });
    });

    it('excludes known-prefixed entries (topic/category/intent/source)', () => {
      const result = transformOtherTagsForFilterDimensions(RAW_MIXED);
      expect(result).to.not.have.property('topic');
      expect(result).to.not.have.property('category');
      expect(result).to.not.have.property('intent');
      expect(result).to.not.have.property('source');
    });

    it('groups unknown prefix:value tags by their prefix', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'type:branded' },
            { value: 'type:unbranded' },
            { value: 'abc:value' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.type).to.deep.equal([
        { id: 'type:branded', label: 'branded' },
        { id: 'type:unbranded', label: 'unbranded' },
      ]);
      expect(result.abc).to.deep.equal([{ id: 'abc:value', label: 'value' }]);
      expect(result.tags).to.deep.equal([]);
    });

    it('collects plain, prefix-less tags into the generic tags array', () => {
      const raw = { blocks: { value: [{ value: 'abc' }, { value: 'another-plain-tag' }] } };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.tags).to.deep.equal([
        { id: 'abc', label: 'abc' },
        { id: 'another-plain-tag', label: 'another-plain-tag' },
      ]);
    });

    it('applies Parent__Child splitting to grouped and plain tags alike', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'type:Branded__Sub' },
            { value: 'Parent__Child' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.type).to.deep.equal([
        {
          id: 'type:Branded__Sub', label: 'Sub', parent_id: 'type:Branded', parent_label: 'Branded',
        },
      ]);
      expect(result.tags).to.deep.equal([
        {
          id: 'Parent__Child', label: 'Child', parent_id: 'Parent', parent_label: 'Parent',
        },
      ]);
    });

    it('ignores empty string values', () => {
      const raw = { blocks: { value: [{ value: '' }, { value: 'abc' }] } };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.tags).to.deep.equal([{ id: 'abc', label: 'abc' }]);
    });

    it('routes tags whose prefix collides with a reserved result key into tags instead of a dynamic group', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'brands:foo' },
            { value: 'regions:APAC' },
            { value: 'topics:x' },
            { value: 'categories:x' },
            { value: 'page_intents:x' },
            { value: 'origins:x' },
            { value: 'tags:x' },
            { value: 'type:branded' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw, RESERVED_RESULT_KEYS);
      expect(result).to.not.have.property('brands');
      expect(result).to.not.have.property('regions');
      expect(result).to.not.have.property('topics');
      expect(result).to.not.have.property('categories');
      expect(result).to.not.have.property('page_intents');
      expect(result).to.not.have.property('origins');
      expect(result.type).to.deep.equal([{ id: 'type:branded', label: 'branded' }]);
      expect(result.tags).to.deep.equal([
        { id: 'brands:foo', label: 'foo' },
        { id: 'regions:APAC', label: 'APAC' },
        { id: 'topics:x', label: 'x' },
        { id: 'categories:x', label: 'x' },
        { id: 'page_intents:x', label: 'x' },
        { id: 'origins:x', label: 'x' },
        { id: 'tags:x', label: 'x' },
      ]);
    });

    it('reconstructs parent_id with the reserved-key prefix when a colliding tag has a Parent__Child value', () => {
      const raw = { blocks: { value: [{ value: 'topics:Parent__Child' }] } };
      const result = transformOtherTagsForFilterDimensions(raw, RESERVED_RESULT_KEYS);
      expect(result.tags).to.deep.equal([
        {
          id: 'topics:Parent__Child', label: 'Child', parent_id: 'topics:Parent', parent_label: 'Parent',
        },
      ]);
    });

    it('does not throw for an Object.prototype-named prefix and does not leak the prototype value', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'constructor:evil' },
            { value: 'toString:evil' },
            { value: '__proto__:evil' },
            { value: 'hasOwnProperty:evil' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      const protoKey = ['_', '_', 'proto', '_', '_'].join('');
      expect(result.constructor).to.deep.equal([{ id: 'constructor:evil', label: 'evil' }]);
      expect(result.toString).to.deep.equal([{ id: 'toString:evil', label: 'evil' }]);
      expect(result[protoKey]).to.deep.equal([{ id: `${protoKey}:evil`, label: 'evil' }]);
      expect(result.hasOwnProperty).to.deep.equal([{ id: 'hasOwnProperty:evil', label: 'evil' }]);
      expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
    });

    it('routes Object.prototype-named prefixes into tags when they are reserved by the caller', () => {
      const raw = { blocks: { value: [{ value: 'constructor:evil' }, { value: '__proto__:evil' }] } };
      const result = transformOtherTagsForFilterDimensions(raw, RESERVED_RESULT_KEYS);
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).to.equal(false);
      expect(result.tags).to.deep.equal([
        { id: 'constructor:evil', label: 'evil' },
        { id: '__proto__:evil', label: 'evil' },
      ]);
    });
  });
});
