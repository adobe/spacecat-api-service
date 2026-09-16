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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  isTagSearchDisabled,
  MAX_TREE_CONCURRENCY,
  MAX_TREE_DURATION_MS,
  MAX_TREE_NODES,
  MAX_TREE_PARENT_READS,
  resolveTagTreeBudgets,
} from '../../../src/support/serenity/tag-search-constants.js';

use(sinonChai);

const DEFAULTS = {
  maxParents: MAX_TREE_PARENT_READS,
  maxNodes: MAX_TREE_NODES,
  maxDurationMs: MAX_TREE_DURATION_MS,
  concurrency: MAX_TREE_CONCURRENCY,
  maxPagesPerParent: 50,
};

describe('Serenity tag-tree budget configuration', () => {
  it('falls back to the compiled defaults with no env', () => {
    expect(resolveTagTreeBudgets(undefined)).to.deep.equal(DEFAULTS);
    expect(resolveTagTreeBudgets({})).to.deep.equal(DEFAULTS);
  });

  it('reads every budget from env so an environment tunes without a redeploy', () => {
    expect(resolveTagTreeBudgets({
      SERENITY_TAG_TREE_MAX_PARENTS: '400',
      SERENITY_TAG_TREE_MAX_NODES: '25000',
      SERENITY_TAG_TREE_MAX_DURATION_MS: '20000',
      SERENITY_TAG_TREE_CONCURRENCY: '3',
      SERENITY_TAG_TREE_MAX_PAGES_PER_PARENT: '75',
    })).to.deep.equal({
      maxParents: 400,
      maxNodes: 25_000,
      maxDurationMs: 20_000,
      concurrency: 3,
      maxPagesPerParent: 75,
    });
  });

  it('ignores unusable values rather than unbounding the walk, and warns', () => {
    const log = { warn: sinon.stub() };
    expect(resolveTagTreeBudgets({
      SERENITY_TAG_TREE_MAX_PARENTS: '0',
      SERENITY_TAG_TREE_MAX_NODES: '-1',
      SERENITY_TAG_TREE_MAX_DURATION_MS: 'soon',
      SERENITY_TAG_TREE_CONCURRENCY: '2.5',
      SERENITY_TAG_TREE_MAX_PAGES_PER_PARENT: '0',
    }, log)).to.deep.equal(DEFAULTS);
    expect(log.warn.callCount).to.equal(5);
  });

  it('treats unset and blank alike, without warning', () => {
    const log = { warn: sinon.stub() };
    expect(resolveTagTreeBudgets({
      SERENITY_TAG_TREE_MAX_PARENTS: '',
      SERENITY_TAG_TREE_MAX_NODES: '   ',
    }, log)).to.deep.equal(DEFAULTS);
    expect(log.warn).to.not.have.been.called;
  });

  it('does not warn when an explicit value simply equals the default', () => {
    const log = { warn: sinon.stub() };
    expect(resolveTagTreeBudgets({
      SERENITY_TAG_TREE_MAX_PARENTS: String(MAX_TREE_PARENT_READS),
    }, log)).to.deep.equal(DEFAULTS);
    expect(log.warn).to.not.have.been.called;
  });

  it('accepts a numeric env value, not only a string', () => {
    expect(resolveTagTreeBudgets({ SERENITY_TAG_TREE_CONCURRENCY: 2 }))
      .to.deep.include({ concurrency: 2 });
  });

  it('leaves search enabled unless the kill switch is explicitly "true"', () => {
    expect(isTagSearchDisabled(undefined)).to.equal(false);
    expect(isTagSearchDisabled({})).to.equal(false);
    expect(isTagSearchDisabled({ SERENITY_TAG_SEARCH_DISABLED: 'false' })).to.equal(false);
    expect(isTagSearchDisabled({ SERENITY_TAG_SEARCH_DISABLED: '1' })).to.equal(false);
    expect(isTagSearchDisabled({ SERENITY_TAG_SEARCH_DISABLED: 'true' })).to.equal(true);
    expect(isTagSearchDisabled({ SERENITY_TAG_SEARCH_DISABLED: ' TRUE ' })).to.equal(true);
    expect(isTagSearchDisabled({ SERENITY_TAG_SEARCH_DISABLED: true })).to.equal(true);
  });
});
