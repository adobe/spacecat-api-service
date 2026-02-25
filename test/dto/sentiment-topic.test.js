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

/* eslint-env mocha */

import { expect } from 'chai';
import { SentimentTopicDto } from '../../src/dto/sentiment-topic.js';

describe('SentimentTopicDto', () => {
  describe('toJSON', () => {
    it('converts a SentimentTopic object to JSON (composite key: siteId + topicId)', () => {
      const mockTopic = {
        getSiteId: () => 'site-123',
        getTopicId: () => 'topic-456',
        getName: () => '2026 Corvette Stingray',
        getDescription: () => 'Latest corvette model reviews',
        getSubPrompts: () => ['Focus on performance', 'Analyze design feedback'],
        getEnabled: () => true,
        getCreatedAt: () => '2026-01-01T00:00:00Z',
        getUpdatedAt: () => '2026-01-02T00:00:00Z',
        getCreatedBy: () => 'user-alice',
        getUpdatedBy: () => 'user-bob',
      };

      const result = SentimentTopicDto.toJSON(mockTopic);

      expect(result).to.deep.equal({
        siteId: 'site-123',
        topicId: 'topic-456',
        name: '2026 Corvette Stingray',
        description: 'Latest corvette model reviews',
        subPrompts: ['Focus on performance', 'Analyze design feedback'],
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        createdBy: 'user-alice',
        updatedBy: 'user-bob',
      });
    });

    it('handles empty arrays', () => {
      const mockTopic = {
        getSiteId: () => 'site-456',
        getTopicId: () => 'topic-789',
        getName: () => 'Empty Topic',
        getDescription: () => undefined,
        getSubPrompts: () => [],
        getEnabled: () => false,
        getCreatedAt: () => '2026-01-01T00:00:00Z',
        getUpdatedAt: () => '2026-01-01T00:00:00Z',
        getCreatedBy: () => 'system',
        getUpdatedBy: () => 'system',
      };

      const result = SentimentTopicDto.toJSON(mockTopic);

      expect(result.subPrompts).to.deep.equal([]);
      expect(result.enabled).to.equal(false);
      expect(result.description).to.equal(undefined);
    });

    it('handles null/undefined values from getters', () => {
      const mockTopic = {
        getSiteId: () => 'site-789',
        getTopicId: () => 'topic-abc',
        getName: () => 'Test Topic',
        getDescription: () => null,
        getSubPrompts: () => undefined,
        getEnabled: () => true,
        getCreatedAt: () => null,
        getUpdatedAt: () => undefined,
        getCreatedBy: () => undefined,
        getUpdatedBy: () => null,
      };

      const result = SentimentTopicDto.toJSON(mockTopic);

      expect(result.siteId).to.equal('site-789');
      expect(result.topicId).to.equal('topic-abc');
      expect(result.name).to.equal('Test Topic');
      expect(result.description).to.equal(null);
      // Arrays should default to empty arrays when null/undefined
      expect(result.subPrompts).to.deep.equal([]);
    });
  });
});
