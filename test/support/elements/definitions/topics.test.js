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
} from '../../../../src/support/elements/definitions/topics.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

const RAW_MIXED = {
  blocks: {
    value: [
      { value: 'topic:SEO' },
      { value: 'topic:AI' },
      { value: 'category:Firefly' },
      { value: 'category:Experience Cloud' },
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
        { id: null, label: 'SEO' },
        { id: null, label: 'AI' },
      ]);
    });

    it('sets id to null for each entry', () => {
      const raw = { blocks: { value: [{ value: 'topic:SEO' }] } };
      const [item] = transformTopicsForFilterDimensions(raw);
      expect(item.id).to.be.null;
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
        { id: null, label: 'Firefly' },
        { id: null, label: 'Experience Cloud' },
      ]);
    });

    it('sets id to null for each entry', () => {
      const raw = { blocks: { value: [{ value: 'category:Creative' }] } };
      const [item] = transformCategoriesToFilterDimensions(raw);
      expect(item.id).to.be.null;
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
        { id: 'INFORMATIONAL', label: 'Informational' },
        { id: 'TRANSACTIONAL', label: 'Transactional' },
      ]);
    });

    it('uppercases id but preserves original casing in label', () => {
      const raw = { blocks: { value: [{ value: 'intent:informational' }] } };
      const [item] = transformIntentsToFilterDimensions(raw);
      expect(item.id).to.equal('INFORMATIONAL');
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
        { id: 'organic', label: 'organic' },
        { id: 'paid', label: 'paid' },
      ]);
    });

    it('sets both id and label to the stripped label value', () => {
      const raw = { blocks: { value: [{ value: 'source:direct' }] } };
      const [item] = transformOriginsToFilterDimensions(raw);
      expect(item.id).to.equal('direct');
      expect(item.label).to.equal('direct');
    });

    it('excludes non-source entries', () => {
      const raw = { blocks: { value: [{ value: 'topic:SEO' }, { value: 'source:organic' }] } };
      const result = transformOriginsToFilterDimensions(raw);
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('organic');
    });
  });
});
