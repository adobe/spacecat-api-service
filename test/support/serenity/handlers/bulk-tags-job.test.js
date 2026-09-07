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
import { pageBulkFailures } from '../../../../src/support/serenity/handlers/bulk-tags-job.js';

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
