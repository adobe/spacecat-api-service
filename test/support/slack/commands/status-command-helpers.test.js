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
  parseStatusCommandArgs,
  parseUtcDateArg,
} from '../../../../src/support/slack/commands/status-command-helpers.js';

describe('status command helpers', () => {
  it('returns null when parseUtcDateArg receives a non-date token', () => {
    expect(parseUtcDateArg('not-a-date')).to.equal(null);
  });

  it('rejects a duplicate bare UUID after a siteId key argument', () => {
    const firstSiteId = '11111111-2222-3333-4444-555555555555';
    const secondSiteId = '22222222-3333-4444-5555-555555555555';
    expect(parseStatusCommandArgs([`siteId=${firstSiteId}`, secondSiteId])).to.deep.equal({
      error: ':warning: Duplicate siteId argument.',
    });
  });
});
