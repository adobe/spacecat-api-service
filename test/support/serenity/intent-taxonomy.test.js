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
  parseSerenityIntent,
  inspectSerenityIntent,
  SERENITY_INTENT_VALUES,
  PROMPT_INTENT_MIN_CONFIDENCE,
  SERENITY_INTENT_CATEGORY_SPEC,
} from '../../../src/support/serenity/intent-taxonomy.js';

describe('intent-taxonomy.js — parseSerenityIntent (serenity-docs#32)', () => {
  it('returns the ready-to-use wire tag for a valid value at/above the confidence floor', () => {
    expect(parseSerenityIntent({ intent: 'Task', confidence: PROMPT_INTENT_MIN_CONFIDENCE }))
      .to.equal('intent:Task');
    expect(parseSerenityIntent({ intent: 'Informational', confidence: 0.99 }))
      .to.equal('intent:Informational');
  });

  it('accepts every canonical value', () => {
    SERENITY_INTENT_VALUES.forEach((value) => {
      expect(parseSerenityIntent({ intent: value, confidence: 1 })).to.equal(`intent:${value}`);
    });
  });

  it('returns null for a value outside the 5 canonical Capitalized literals (case-sensitive)', () => {
    expect(parseSerenityIntent({ intent: 'informational', confidence: 1 })).to.equal(null);
    expect(parseSerenityIntent({ intent: 'not-a-real-value', confidence: 1 })).to.equal(null);
    expect(parseSerenityIntent({ intent: undefined, confidence: 1 })).to.equal(null);
  });

  it('returns null when confidence is below the validity floor', () => {
    expect(parseSerenityIntent({ intent: 'Task', confidence: PROMPT_INTENT_MIN_CONFIDENCE - 0.01 }))
      .to.equal(null);
  });

  it('returns null when confidence is missing, non-numeric, or non-finite', () => {
    expect(parseSerenityIntent({ intent: 'Task' })).to.equal(null);
    expect(parseSerenityIntent({ intent: 'Task', confidence: 'high' })).to.equal(null);
    expect(parseSerenityIntent({ intent: 'Task', confidence: NaN })).to.equal(null);
    expect(parseSerenityIntent({ intent: 'Task', confidence: Infinity })).to.equal(null);
  });

  it('returns null for a garbled/empty parsed body', () => {
    expect(parseSerenityIntent({})).to.equal(null);
    expect(parseSerenityIntent(null)).to.equal(null);
    expect(parseSerenityIntent(undefined)).to.equal(null);
  });

  it('exposes the category spec with the fixed per-call timeout, not env-driven', () => {
    expect(SERENITY_INTENT_CATEGORY_SPEC.parseResult).to.equal(parseSerenityIntent);
    expect(SERENITY_INTENT_CATEGORY_SPEC.invokeTimeoutMs).to.be.a('number').greaterThan(0);
    expect(SERENITY_INTENT_CATEGORY_SPEC.systemPrompt).to.be.a('string').with.length.greaterThan(0);
  });
});

describe('intent-taxonomy.js — inspectSerenityIntent (serenity-docs#32 observability)', () => {
  it('returns ok with the wire tag and surfaced fields for a valid, confident result', () => {
    const r = inspectSerenityIntent({ intent: 'Task', confidence: 0.97, reasoning: 'delegated pick' });
    expect(r).to.deep.equal({
      tag: 'intent:Task', reason: 'ok', confidence: 0.97, reasoning: 'delegated pick',
    });
  });

  it('flags a recognized value below the confidence floor as low_confidence, still tag null', () => {
    const r = inspectSerenityIntent({
      intent: 'Commercial', confidence: PROMPT_INTENT_MIN_CONFIDENCE - 0.01, reasoning: 'unsure',
    });
    expect(r.tag).to.equal(null);
    expect(r.reason).to.equal('low_confidence');
    expect(r.reasoning).to.equal('unsure');
  });

  it('flags an unrecognized/garbled value as invalid_value before the confidence check', () => {
    expect(inspectSerenityIntent({ intent: 'nope', confidence: 0.99 }).reason).to.equal('invalid_value');
    expect(inspectSerenityIntent({}).reason).to.equal('invalid_value');
    expect(inspectSerenityIntent(null).reason).to.equal('invalid_value');
  });

  it('defaults reasoning to an empty string when absent or non-string', () => {
    expect(inspectSerenityIntent({ intent: 'Task', confidence: 1 }).reasoning).to.equal('');
    expect(inspectSerenityIntent({ intent: 'Task', confidence: 1, reasoning: 42 }).reasoning).to.equal('');
  });

  it('parseSerenityIntent is the tag projection of inspectSerenityIntent', () => {
    const parsed = { intent: 'Navigational', confidence: 0.9, reasoning: 'go to site' };
    expect(parseSerenityIntent(parsed)).to.equal(inspectSerenityIntent(parsed).tag);
    expect(parseSerenityIntent({ intent: 'x' })).to.equal(inspectSerenityIntent({ intent: 'x' }).tag);
  });
});
