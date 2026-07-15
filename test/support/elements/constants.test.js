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

/*
 * Tests for resolveElementModel — the UI-platform-code → Semrush-model translation
 * shared by every Elements definition (LLMO-6011 POC, previously c8-ignored).
 */

import { expect } from 'chai';
import {
  resolveElementModel,
  DEFAULT_ELEMENT_MODEL,
  ELEMENT_MODELS,
} from '../../../src/support/elements/constants.js';

describe('resolveElementModel', () => {
  it('translates UI platform codes to Semrush model names', () => {
    expect(resolveElementModel('openai')).to.equal('gpt-5');
    expect(resolveElementModel('chatgpt')).to.equal('search-gpt');
    expect(resolveElementModel('gemini')).to.equal('gemini-2.5-flash');
    expect(resolveElementModel('copilot')).to.equal('microsoft-copilot');
  });

  it('passes through a value that is already a valid Semrush model', () => {
    expect(resolveElementModel('perplexity')).to.equal('perplexity');
    expect(resolveElementModel('grok-3')).to.equal('grok-3');
    // every known model resolves to itself
    for (const model of ELEMENT_MODELS) {
      expect(resolveElementModel(model)).to.equal(model);
    }
  });

  it('falls back to the default model for unknown or missing values', () => {
    expect(resolveElementModel('not-a-model')).to.equal(DEFAULT_ELEMENT_MODEL);
    expect(resolveElementModel(undefined)).to.equal(DEFAULT_ELEMENT_MODEL);
    expect(resolveElementModel('')).to.equal(DEFAULT_ELEMENT_MODEL);
  });
});
