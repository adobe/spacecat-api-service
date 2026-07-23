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
      { value: 'topic' },
      { value: 'topic__SEO' },
      { value: 'topic__AI' },
      { value: 'category' },
      { value: 'category__Firefly' },
      { value: 'category__Experience Cloud' },
      { value: 'category__Modular & Configurable Sofas__Compact Shippable Furniture' },
      { value: 'topic__Furniture__Compact Shippable Furniture' },
      { value: 'intent' },
      { value: 'intent__Informational' },
      { value: 'intent__Transactional' },
      { value: 'source' },
      { value: 'source__organic' },
      { value: 'source__paid' },
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
      expect(payload.filters.advanced.filters[0].val).to.equal('chatgpt-paid');
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

    it('ignores the bare "topic" prefix declaration and returns only topic__-prefixed entries', () => {
      const result = transformTopicsForFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'topic__SEO', label: 'SEO' },
        { id: 'topic__AI', label: 'AI' },
        {
          id: 'topic__Furniture__Compact Shippable Furniture',
          label: 'Compact Shippable Furniture',
          parent_id: 'topic__Furniture',
          parent_label: 'Furniture',
        },
      ]);
    });

    it('adds parent_id/parent_label when the value contains a double underscore', () => {
      const raw = { blocks: { value: [{ value: 'topic__Furniture__Sofas' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'topic__Furniture__Sofas',
        label: 'Sofas',
        parent_id: 'topic__Furniture',
        parent_label: 'Furniture',
      });
    });

    it('splits only on the first double underscore after the prefix', () => {
      const raw = { blocks: { value: [{ value: 'topic__A__B__C' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'topic__A__B__C',
        label: 'B__C',
        parent_id: 'topic__A',
        parent_label: 'A',
      });
    });

    it('sets id to the original tag value (including prefix) for each entry', () => {
      const raw = { blocks: { value: [{ value: 'topic__SEO' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item.id).to.equal('topic__SEO');
    });

    it('strips the topic__ prefix from the label', () => {
      const raw = { blocks: { value: [{ value: 'topic__Machine Learning' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item.label).to.equal('Machine Learning');
    });

    it('excludes non-topic entries', () => {
      const raw = { blocks: { value: [{ value: 'category__Firefly' }, { value: 'topic__SEO' }] } };
      const result = transformTopicsForFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('SEO');
    });

    it('ignores a bare "topic" declaration with no value', () => {
      const raw = { blocks: { value: [{ value: 'topic' }] } };
      expect(transformTopicsForFilterDimensions(raw)).to.deep.equal([]);
    });
  });

  describe('transformCategoriesToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformCategoriesToFilterDimensions(null)).to.deep.equal([]);
    });

    it('ignores the bare "category" prefix declaration and returns only category__-prefixed entries', () => {
      const result = transformCategoriesToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'category__Firefly', label: 'Firefly' },
        { id: 'category__Experience Cloud', label: 'Experience Cloud' },
        {
          id: 'category__Modular & Configurable Sofas__Compact Shippable Furniture',
          label: 'Compact Shippable Furniture',
          parent_id: 'category__Modular & Configurable Sofas',
          parent_label: 'Modular & Configurable Sofas',
        },
      ]);
    });

    it('adds parent_id/parent_label when the value contains a double underscore', () => {
      const raw = { blocks: { value: [{ value: 'category__Sofas__Modular Sofas' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category__Sofas__Modular Sofas',
        label: 'Modular Sofas',
        parent_id: 'category__Sofas',
        parent_label: 'Sofas',
      });
    });

    it('splits only on the first double underscore after the prefix', () => {
      const raw = { blocks: { value: [{ value: 'category__A__B__C' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category__A__B__C',
        label: 'B__C',
        parent_id: 'category__A',
        parent_label: 'A',
      });
    });

    it('handles a parent label identical to the child label (real production data)', () => {
      // Live Semrush taxonomy sometimes repeats the leaf name as its own parent,
      // e.g. "category__Product__Product" — label/parent_label must not be swapped.
      const raw = { blocks: { value: [{ value: 'category__Product__Product' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category__Product__Product',
        label: 'Product',
        parent_id: 'category__Product',
        parent_label: 'Product',
      });
    });

    it('preserves non-ASCII characters and parentheses in the label untouched (real production data)', () => {
      const raw = {
        blocks: { value: [{ value: 'category__Brand__Marca Lovesac (ES)' }] },
      };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category__Brand__Marca Lovesac (ES)',
        label: 'Marca Lovesac (ES)',
        parent_id: 'category__Brand',
        parent_label: 'Brand',
      });
    });

    it('sets id to the original tag value (including prefix) for each entry', () => {
      const raw = { blocks: { value: [{ value: 'category__Creative' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item.id).to.equal('category__Creative');
    });

    it('sets parent_id to the prefix plus the parent label', () => {
      const raw = {
        blocks: {
          value: [{ value: 'category__Living Room Furniture Retail__Living Room Furniture and Sofas' }],
        },
      };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'category__Living Room Furniture Retail__Living Room Furniture and Sofas',
        label: 'Living Room Furniture and Sofas',
        parent_id: 'category__Living Room Furniture Retail',
        parent_label: 'Living Room Furniture Retail',
      });
    });

    it('strips the category__ prefix from the label', () => {
      const raw = { blocks: { value: [{ value: 'category__Creative Cloud' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item.label).to.equal('Creative Cloud');
    });

    it('excludes non-category entries', () => {
      const raw = { blocks: { value: [{ value: 'topic__SEO' }, { value: 'category__AI' }] } };
      const result = transformCategoriesToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('AI');
    });

    it('ignores a bare "category" declaration with no value', () => {
      const raw = { blocks: { value: [{ value: 'category' }] } };
      expect(transformCategoriesToFilterDimensions(raw)).to.deep.equal([]);
    });
  });

  describe('transformIntentsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformIntentsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('ignores the bare "intent" prefix declaration and returns only intent__-prefixed entries', () => {
      const result = transformIntentsToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'intent__Informational', label: 'Informational' },
        { id: 'intent__Transactional', label: 'Transactional' },
      ]);
    });

    it('sets id to the original tag value (including prefix) and preserves original casing in label', () => {
      const raw = { blocks: { value: [{ value: 'intent__informational' }] } };
      const [item] = transformIntentsToFilterDimensions(raw);
      expect(item.id).to.equal('intent__informational');
      expect(item.label).to.equal('informational');
    });

    it('excludes non-intent entries', () => {
      const raw = { blocks: { value: [{ value: 'category__AI' }, { value: 'intent__Buy' }] } };
      const result = transformIntentsToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].label).to.equal('Buy');
    });

    it('adds parent_id/parent_label when the value contains a double underscore', () => {
      const raw = { blocks: { value: [{ value: 'intent__Commercial__Buy' }] } };
      const [item] = transformIntentsToFilterDimensions(raw);
      expect(item).to.deep.equal({
        id: 'intent__Commercial__Buy',
        label: 'Buy',
        parent_id: 'intent__Commercial',
        parent_label: 'Commercial',
      });
    });
  });

  describe('transformOriginsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformOriginsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('ignores the bare "source" prefix declaration and returns only source__-prefixed entries', () => {
      const result = transformOriginsToFilterDimensions(RAW_MIXED);
      expect(result).to.deep.equal([
        { id: 'source__organic', label: 'organic' },
        { id: 'source__paid', label: 'paid' },
      ]);
    });

    it('sets id to the original tag value (including prefix) and label to the stripped value', () => {
      const raw = { blocks: { value: [{ value: 'source__direct' }] } };
      const [item] = transformOriginsToFilterDimensions(raw);
      expect(item.id).to.equal('source__direct');
      expect(item.label).to.equal('direct');
    });

    it('excludes non-source entries', () => {
      const raw = { blocks: { value: [{ value: 'topic__SEO' }, { value: 'source__organic' }] } };
      const result = transformOriginsToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('source__organic');
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
      expect(result.tags).to.deep.equal([]);
    });

    it('groups unknown prefix__value tags by their prefix', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'type' },
            { value: 'type__branded' },
            { value: 'type__unbranded' },
            { value: 'abc__value' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.type).to.deep.equal([
        { id: 'type__branded', label: 'branded' },
        { id: 'type__unbranded', label: 'unbranded' },
      ]);
      expect(result.abc).to.deep.equal([{ id: 'abc__value', label: 'value' }]);
      expect(result.tags).to.deep.equal([]);
    });

    it('ignores bare prefix declarations (values with no double underscore)', () => {
      const raw = { blocks: { value: [{ value: 'abc' }, { value: 'another-plain-tag' }] } };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.tags).to.deep.equal([]);
      expect(Object.keys(result)).to.deep.equal(['tags']);
    });

    it('applies Parent__Child splitting to grouped tags and to unreserved plain-prefix tags', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'type__Branded__Sub' },
            { value: 'Parent__Child' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.type).to.deep.equal([
        {
          id: 'type__Branded__Sub', label: 'Sub', parent_id: 'type__Branded', parent_label: 'Branded',
        },
      ]);
      expect(result.Parent).to.deep.equal([
        { id: 'Parent__Child', label: 'Child' },
      ]);
      expect(result.tags).to.deep.equal([]);
    });

    it('ignores empty string values', () => {
      const raw = { blocks: { value: [{ value: '' }, { value: 'abc' }] } };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.tags).to.deep.equal([]);
    });

    it('routes tags whose prefix collides with a reserved result key into tags instead of a dynamic group', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'brands__foo' },
            { value: 'regions__APAC' },
            { value: 'topics__x' },
            { value: 'categories__x' },
            { value: 'page_intents__x' },
            { value: 'origins__x' },
            { value: 'tags__x' },
            { value: 'type__branded' },
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
      expect(result.type).to.deep.equal([{ id: 'type__branded', label: 'branded' }]);
      expect(result.tags).to.deep.equal([
        { id: 'brands__foo', label: 'foo' },
        { id: 'regions__APAC', label: 'APAC' },
        { id: 'topics__x', label: 'x' },
        { id: 'categories__x', label: 'x' },
        { id: 'page_intents__x', label: 'x' },
        { id: 'origins__x', label: 'x' },
        { id: 'tags__x', label: 'x' },
      ]);
    });

    it('reconstructs parent_id with the reserved-key prefix when a colliding tag has a Parent__Child value', () => {
      const raw = { blocks: { value: [{ value: 'topics__Parent__Child' }] } };
      const result = transformOtherTagsForFilterDimensions(raw, RESERVED_RESULT_KEYS);
      expect(result.tags).to.deep.equal([
        {
          id: 'topics__Parent__Child', label: 'Child', parent_id: 'topics__Parent', parent_label: 'Parent',
        },
      ]);
    });

    it('does not throw for an Object.prototype-named prefix and does not leak the prototype value', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'constructor__evil' },
            { value: 'toString__evil' },
            { value: 'hasOwnProperty__evil' },
          ],
        },
      };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result.constructor).to.deep.equal([{ id: 'constructor__evil', label: 'evil' }]);
      expect(result.toString).to.deep.equal([{ id: 'toString__evil', label: 'evil' }]);
      expect(result.hasOwnProperty).to.deep.equal([{ id: 'hasOwnProperty__evil', label: 'evil' }]);
      expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
    });

    it('does not throw and does not pollute the prototype for a value starting with the separator itself', () => {
      // A value starting with "__" (e.g. a literal "__proto__..." tag) yields an
      // empty-string prefix under first-occurrence splitting — still safe because
      // `groups` is created with Object.create(null).
      const raw = { blocks: { value: [{ value: '__proto__evil' }] } };
      const result = transformOtherTagsForFilterDimensions(raw);
      expect(result['']).to.deep.equal([
        {
          id: '__proto__evil', label: 'evil', parent_id: '__proto', parent_label: 'proto',
        },
      ]);
      expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
    });

    it('routes Object.prototype-named prefixes into tags when they are reserved by the caller', () => {
      const raw = { blocks: { value: [{ value: 'constructor__evil' }] } };
      const result = transformOtherTagsForFilterDimensions(raw, RESERVED_RESULT_KEYS);
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).to.equal(false);
      expect(result.tags).to.deep.equal([
        { id: 'constructor__evil', label: 'evil' },
      ]);
    });
  });
});
