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
  DEFER_PUBLISH_ENV_FLAG,
  isSerenityDeferPublishEnabled,
} from '../../../src/support/serenity/defer-publish-active.js';

describe('serenity defer-publish flag (LLMO-5492)', () => {
  it('exposes the env flag name', () => {
    expect(DEFER_PUBLISH_ENV_FLAG).to.equal('SERENITY_DEFER_PUBLISH');
  });

  it('is ON only for the exact string "true"', () => {
    expect(isSerenityDeferPublishEnabled({ SERENITY_DEFER_PUBLISH: 'true' })).to.be.true;
  });

  it('is OFF (fail-safe) for false, typos, non-string, unset, and missing env', () => {
    expect(isSerenityDeferPublishEnabled({ SERENITY_DEFER_PUBLISH: 'false' })).to.be.false;
    expect(isSerenityDeferPublishEnabled({ SERENITY_DEFER_PUBLISH: 'TRUE' })).to.be.false;
    expect(isSerenityDeferPublishEnabled({ SERENITY_DEFER_PUBLISH: true })).to.be.false;
    expect(isSerenityDeferPublishEnabled({})).to.be.false;
    expect(isSerenityDeferPublishEnabled(undefined)).to.be.false;
  });
});
