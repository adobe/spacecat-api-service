/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { WEBHOOK_METRICS } from '../src/support/github-webhook-metrics.js';

describe('webhook metrics catalog drift-guard', () => {
  it('metrics.yaml names exactly match WEBHOOK_METRICS', () => {
    const doc = yaml.load(readFileSync(new URL('../metrics.yaml', import.meta.url), 'utf8'));
    expect(doc.metrics.map((m) => m.name).sort()).to.deep.equal([...WEBHOOK_METRICS].sort());
  });
});
