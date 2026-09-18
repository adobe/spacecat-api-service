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
import { ResponseFeedDto } from '../../src/dto/response-feed.js';

const row = {
  projectId: 'project-1',
  prompt: 'Which shoes are best?',
  response: 'A complete answer',
  date: '2026-09-07',
  model: 'search-gpt',
  responses: 1,
  sources: ['https://example.com/b', 'https://example.com/a'],
  tags: ['$abv_tags$intent__commercial'],
};

describe('ResponseFeedDto', () => {
  it('preserves the frozen normalized row, including source order', () => {
    expect(ResponseFeedDto.toJSON(row)).to.deep.equal(row);
  });

  it('wraps data with page and slice metadata', () => {
    const page = {
      offset: 0, pageSize: 500, returned: 1, rowCount: 1, nextOffset: null,
    };
    const slice = {
      geoTargetId: 2840,
      languageCode: 'en',
      date: '2026-09-07',
      model: 'search-gpt',
    };
    expect(ResponseFeedDto.toEnvelopeJSON({ data: [row], page, slice })).to.deep.equal({
      data: [row], page, slice,
    });
  });
});
