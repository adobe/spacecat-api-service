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
  NO_MATCH,
  CATEGORY_MIN_CONFIDENCE,
  buildCategorySystemPrompt,
  inspectTopicCategory,
  buildCategoryClassificationSpec,
} from '../../../src/support/serenity/category-taxonomy.js';

describe('category-taxonomy.js — buildCategorySystemPrompt (adobe/serenity-docs#44)', () => {
  it('embeds every candidate category name, one per line', () => {
    const prompt = buildCategorySystemPrompt(['Shoes', 'Apparel', 'Accessories']);
    expect(prompt).to.include('- Shoes');
    expect(prompt).to.include('- Apparel');
    expect(prompt).to.include('- Accessories');
  });

  it('embeds the NO_MATCH sentinel so the model can decline a match', () => {
    const prompt = buildCategorySystemPrompt(['Shoes']);
    expect(prompt).to.include(NO_MATCH);
  });

  it('never contains fixed intent/taxonomy language — categories are per-call, not baked in', () => {
    const promptA = buildCategorySystemPrompt(['Shoes']);
    const promptB = buildCategorySystemPrompt(['Furniture', 'Lighting']);
    expect(promptA).to.not.equal(promptB);
    expect(promptB).to.include('- Furniture');
    expect(promptB).to.include('- Lighting');
    expect(promptB).to.not.include('- Shoes');
  });
});

describe('category-taxonomy.js — inspectTopicCategory', () => {
  const categoryNames = ['Shoes', 'Apparel'];

  it('returns ok + the matched name for a valid candidate at/above the confidence floor', () => {
    const r = inspectTopicCategory({ category: 'Shoes', confidence: CATEGORY_MIN_CONFIDENCE }, categoryNames);
    expect(r).to.deep.equal({
      value: 'Shoes', reason: 'ok', confidence: CATEGORY_MIN_CONFIDENCE, reasoning: '',
    });
  });

  it('returns no_match (not invalid_value) for the explicit NO_MATCH sentinel', () => {
    const r = inspectTopicCategory({ category: NO_MATCH, confidence: 0.99 }, categoryNames);
    expect(r.value).to.equal(null);
    expect(r.reason).to.equal('no_match');
  });

  it('returns invalid_value for a hallucinated name outside the candidate set — NEVER accepted', () => {
    const r = inspectTopicCategory({ category: 'Furniture', confidence: 0.99 }, categoryNames);
    expect(r.value).to.equal(null);
    expect(r.reason).to.equal('invalid_value');
  });

  it('returns invalid_value for a candidate name in the wrong case (exact-match only)', () => {
    const r = inspectTopicCategory({ category: 'shoes', confidence: 0.99 }, categoryNames);
    expect(r.value).to.equal(null);
    expect(r.reason).to.equal('invalid_value');
  });

  it('returns low_confidence for a valid candidate below the confidence floor', () => {
    const r = inspectTopicCategory(
      { category: 'Shoes', confidence: CATEGORY_MIN_CONFIDENCE - 0.01 },
      categoryNames,
    );
    expect(r.value).to.equal(null);
    expect(r.reason).to.equal('low_confidence');
  });

  it('returns low_confidence when confidence is missing, non-numeric, or non-finite', () => {
    expect(inspectTopicCategory({ category: 'Shoes' }, categoryNames).reason).to.equal('low_confidence');
    expect(inspectTopicCategory({ category: 'Shoes', confidence: 'high' }, categoryNames).reason)
      .to.equal('low_confidence');
    expect(inspectTopicCategory({ category: 'Shoes', confidence: NaN }, categoryNames).reason)
      .to.equal('low_confidence');
  });

  it('surfaces reasoning verbatim on a soft failure', () => {
    const r = inspectTopicCategory({ category: NO_MATCH, reasoning: 'no fit' }, categoryNames);
    expect(r.reasoning).to.equal('no fit');
  });

  it('treats a garbled/empty parsed body as invalid_value against a non-empty candidate set', () => {
    expect(inspectTopicCategory({}, categoryNames).reason).to.equal('invalid_value');
    expect(inspectTopicCategory(null, categoryNames).reason).to.equal('invalid_value');
  });
});

describe('category-taxonomy.js — buildCategoryClassificationSpec', () => {
  it('builds a spec whose systemPrompt embeds the candidate set and whose parseResult delegates to inspectTopicCategory', () => {
    const spec = buildCategoryClassificationSpec(['Shoes', 'Apparel'], 1234);
    expect(spec.systemPrompt).to.include('- Shoes');
    expect(spec.invokeTimeoutMs).to.equal(1234);
    expect(spec.parseResult({ category: 'Shoes', confidence: 0.9 })).to.equal('Shoes');
    expect(spec.parseResult({ category: NO_MATCH, confidence: 0.9 })).to.equal(null);
  });

  it('omits invokeTimeoutMs from the spec when not provided', () => {
    const spec = buildCategoryClassificationSpec(['Shoes']);
    expect(spec).to.not.have.property('invokeTimeoutMs');
  });
});
