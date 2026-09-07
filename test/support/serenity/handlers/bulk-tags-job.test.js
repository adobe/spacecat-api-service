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
  applyBulkTagOperation,
  matchesBulkTagFacets,
  pageBulkFailures,
  parseBulkTagsBody,
} from '../../../../src/support/serenity/handlers/bulk-tags-job.js';

const snapshot = {
  byId: new Map([
    ['family', { id: 'family', rootName: 'tag', depth: 2, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }] }],
    ['child', { id: 'child', rootName: 'tag', depth: 3, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }, { id: 'child', name: 'Child' }] }],
    ['other', { id: 'other', rootName: 'tag', depth: 2, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'other', name: 'Other' }] }],
  ]),
  items: [],
};
snapshot.items = [...snapshot.byId.values()];

describe('bulk tags job request and tree semantics', () => {
  it('validates the target slice, operation, mutation ids, and faceted filter mode', () => {
    expect(() => parseBulkTagsBody({})).to.throw(/geoTargetId and languageCode/);
    expect(() => parseBulkTagsBody({
      geoTargetId: 1, languageCode: 'en', operation: 'replace', tagIds: ['child'],
      filter: { tagFilterMode: 'faceted-v1' },
    })).to.throw(/operation must be assign or remove/);
    expect(() => parseBulkTagsBody({
      geoTargetId: 1, languageCode: 'en', operation: 'assign', tagIds: [],
      filter: { tagFilterMode: 'faceted-v1' },
    })).to.throw(/tagIds must be a non-empty array/);
    expect(parseBulkTagsBody({
      geoTargetId: 1, languageCode: 'en', operation: 'assign', tagIds: ['child'],
      filter: { tagFilterMode: 'faceted-v1', search: ' shoes ' },
    }).filter).to.deep.equal({ tagIds: [], tagFilterMode: 'faceted-v1', search: 'shoes' });
  });

  it('assigns a child with its parent and removes a parent subtree', () => {
    expect(applyBulkTagOperation([], 'assign', [snapshot.byId.get('child')], snapshot))
      .to.have.members(['child', 'family']);
    expect(applyBulkTagOperation(['family', 'child', 'other'], 'remove', [snapshot.byId.get('family')], snapshot))
      .to.have.members(['other']);
  });

  it('uses OR within each facet family and AND across families', () => {
    expect(matchesBulkTagFacets({ tags: [{ id: 'child' }, { id: 'other' }] }, [
      new Set(['child', 'missing']), new Set(['other']),
    ])).to.equal(true);
    expect(matchesBulkTagFacets({ tags: [{ id: 'child' }] }, [
      new Set(['child']), new Set(['other']),
    ])).to.equal(false);
  });
});

describe('bulk tags job result paging', () => {
  it('returns at most 100 failures and an opaque next cursor', () => {
    const result = pageBulkFailures({
      matchedCount: 101,
      processedCount: 101,
      updatedCount: 0,
      unchangedCount: 0,
      failureCount: 101,
      failures: Array.from({ length: 101 }, (_, index) => ({
        semrushPromptId: `prompt-${index}`,
        code: 'serenityUpstreamError',
        message: 'failed',
        retryable: true,
      })),
      publish: { state: 'SUCCEEDED', error: null },
    });
    expect(result.failuresPage.items).to.have.lengthOf(100);
    expect(result.failuresPage.nextCursor).to.be.a('string');
    expect(result).not.to.have.property('failures');
  });
});
