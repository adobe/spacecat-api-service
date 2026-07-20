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
  TRACKED_PROMPT_SOURCES,
  PERMITTED_LEGACY_SOURCES,
  PERMITTED_PROMPT_SOURCES,
  isPermittedSource,
  assertPermittedSource,
} from '../../src/support/prompt-sources.js';

describe('prompt-sources (SITES-47870 write chokepoint)', () => {
  it('permits every tracked pipeline source', () => {
    for (const source of TRACKED_PROMPT_SOURCES) {
      expect(isPermittedSource(source), source).to.equal(true);
      expect(() => assertPermittedSource(source)).to.not.throw();
    }
  });

  it('permits every legacy/UI source (config, sheet, drift variants)', () => {
    expect(PERMITTED_LEGACY_SOURCES).to.include('config');
    for (const source of PERMITTED_LEGACY_SOURCES) {
      expect(isPermittedSource(source), source).to.equal(true);
      expect(() => assertPermittedSource(source)).to.not.throw();
    }
  });

  it('mirrors the DRS tracked pipeline sources', () => {
    // Guards against drift with llmo-data-retrieval-service prompt_source.py.
    expect(TRACKED_PROMPT_SOURCES).to.have.members([
      'gsc',
      'base_url',
      'citation_attempt',
      'strategy-chat',
      'semrush',
      'synthetic_personas',
    ]);
    for (const source of TRACKED_PROMPT_SOURCES) {
      expect(PERMITTED_PROMPT_SOURCES.has(source)).to.equal(true);
    }
  });

  it('rejects an unregistered source with a 400-typed error', () => {
    expect(isPermittedSource('totally-bogus')).to.equal(false);
    let thrown;
    try {
      assertPermittedSource('totally-bogus');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.an('error');
    expect(thrown.status).to.equal(400);
    expect(thrown.message).to.match(/Unregistered prompt source/);
  });
});
