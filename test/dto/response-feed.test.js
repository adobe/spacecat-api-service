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

const record = (over = {}) => ({
  projectId: 'proj-1',
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  date: '2026-08-24',
  response: 'Some answer text',
  tags: '$abv_tags$type__branded',
  sources: [{
    url: 'https://runnersworld.com/best',
    source: 'runnersworld.com',
    position: 1,
    domainType: 'Earned',
  }],
  sourceRowCount: 1,
  ...over,
});

describe('ResponseFeedDto', () => {
  describe('toJSON', () => {
    it('maps a joined record onto the API contract', () => {
      expect(ResponseFeedDto.toJSON(record())).to.deep.equal({
        projectId: 'proj-1',
        prompt: 'best running shoes',
        model: 'chatgpt-paid',
        date: '2026-08-24',
        response: 'Some answer text',
        sources: [{
          url: 'https://runnersworld.com/best',
          domain: 'runnersworld.com',
          rank: 1,
          domainType: 'Earned',
        }],
        sourceCount: 1,
      });
    });

    // The downstream consumer keys on (prompt, region) and carries no model or date
    // dimension, so it cannot reconstruct either. Dropping them would silently collapse
    // distinct executions into one.
    it('always exposes model and date, which the consumer cannot reconstruct', () => {
      const json = ResponseFeedDto.toJSON(record());
      expect(json).to.have.property('model', 'chatgpt-paid');
      expect(json).to.have.property('date', '2026-08-24');
    });

    it('never leaks upstream-only fields', () => {
      const json = ResponseFeedDto.toJSON(record({
        executionId: 'proj-1|2026-08-24|chatgpt-paid|best running shoes',
        modelNameCbfValue: 'ChatGPT (paid)',
      }));
      expect(json).to.not.have.property('executionId');
      expect(json).to.not.have.property('modelNameCbfValue');
      expect(json).to.not.have.property('tags');
    });

    // Empty sources mean "cited nothing that day", which is routine and not an error.
    it('renders an empty source list rather than omitting the field', () => {
      const json = ResponseFeedDto.toJSON(record({ sources: [], sourceRowCount: 0 }));
      expect(json.sources).to.deep.equal([]);
      expect(json.sourceCount).to.equal(0);
    });

    it('defaults every field on a sparse record instead of emitting undefined', () => {
      expect(ResponseFeedDto.toJSON({})).to.deep.equal({
        projectId: '',
        prompt: '',
        model: '',
        date: '',
        response: '',
        sources: [],
        sourceCount: 0,
      });
    });

    it('defaults missing fields on a sparse source row', () => {
      const json = ResponseFeedDto.toJSON(record({ sources: [{}] }));
      expect(json.sources[0]).to.deep.equal({
        url: '', domain: '', rank: 0, domainType: '',
      });
    });
  });

  describe('toEnvelopeJSON', () => {
    it('wraps the records with the paging and integrity envelope', () => {
      const envelope = ResponseFeedDto.toEnvelopeJSON({
        records: [record()],
        days: ['2026-08-24'],
        projectIds: ['proj-1'],
        pageSize: 5000,
        truncated: false,
        unmatchedSourceKeyCount: 0,
      });

      expect(envelope.totalCount).to.equal(1);
      expect(envelope.days).to.deep.equal(['2026-08-24']);
      expect(envelope.projectIds).to.deep.equal(['proj-1']);
      expect(envelope.pageSize).to.equal(5000);
      expect(envelope.truncated).to.equal(false);
      expect(envelope.unmatchedSourceKeyCount).to.equal(0);
      expect(envelope.records[0].prompt).to.equal('best running shoes');
    });

    // Truncation must be visible: it is what separates an incomplete read from a genuinely
    // quiet day, and a missing tuple is normally legitimate.
    it('surfaces truncation so a clipped window is not read as a quiet day', () => {
      const envelope = ResponseFeedDto.toEnvelopeJSON({
        records: [], days: ['2026-08-24'], truncated: true, unmatchedSourceKeyCount: 3,
      });
      expect(envelope.truncated).to.equal(true);
      expect(envelope.unmatchedSourceKeyCount).to.equal(3);
    });

    it('renders an empty feed without throwing', () => {
      expect(ResponseFeedDto.toEnvelopeJSON({})).to.deep.equal({
        records: [],
        totalCount: 0,
        days: [],
        projectIds: [],
        pageSize: 0,
        truncated: false,
        unmatchedSourceKeyCount: 0,
      });
    });
  });
});
