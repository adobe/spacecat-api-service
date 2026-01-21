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
import { SentimentGuidelineDto } from '../../src/dto/sentiment-guideline.js';

describe('SentimentGuidelineDto', () => {
  describe('toJSON', () => {
    it('converts a SentimentGuideline object to JSON (composite key: siteId + guidelineId)', () => {
      const mockGuideline = {
        getSiteId: () => 'site-123',
        getGuidelineId: () => 'guideline-456',
        getName: () => 'Product Quality Focus',
        getInstruction: () => 'Focus on product quality aspects in sentiment analysis',
        getEnabled: () => true,
        getCreatedAt: () => '2026-01-01T00:00:00Z',
        getUpdatedAt: () => '2026-01-02T00:00:00Z',
        getCreatedBy: () => 'user-alice',
        getUpdatedBy: () => 'user-bob',
      };

      const result = SentimentGuidelineDto.toJSON(mockGuideline);

      expect(result).to.deep.equal({
        siteId: 'site-123',
        guidelineId: 'guideline-456',
        name: 'Product Quality Focus',
        instruction: 'Focus on product quality aspects in sentiment analysis',
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        createdBy: 'user-alice',
        updatedBy: 'user-bob',
      });
    });

    it('handles disabled guideline', () => {
      const mockGuideline = {
        getSiteId: () => 'site-456',
        getGuidelineId: () => 'guideline-789',
        getName: () => 'Competitor Analysis',
        getInstruction: () => 'Analyze competitor mentions',
        getEnabled: () => false,
        getCreatedAt: () => '2026-01-01T00:00:00Z',
        getUpdatedAt: () => '2026-01-01T00:00:00Z',
        getCreatedBy: () => 'system',
        getUpdatedBy: () => 'system',
      };

      const result = SentimentGuidelineDto.toJSON(mockGuideline);

      expect(result.enabled).to.equal(false);
      expect(result.name).to.equal('Competitor Analysis');
    });

    it('handles null/undefined values from getters', () => {
      const mockGuideline = {
        getSiteId: () => 'site-789',
        getGuidelineId: () => 'guideline-abc',
        getName: () => 'Test Guideline',
        getInstruction: () => 'Test instruction',
        getEnabled: () => undefined,
        getCreatedAt: () => null,
        getUpdatedAt: () => undefined,
        getCreatedBy: () => undefined,
        getUpdatedBy: () => null,
      };

      const result = SentimentGuidelineDto.toJSON(mockGuideline);

      expect(result.siteId).to.equal('site-789');
      expect(result.guidelineId).to.equal('guideline-abc');
      expect(result.name).to.equal('Test Guideline');
      expect(result.instruction).to.equal('Test instruction');
      expect(result.enabled).to.equal(undefined);
      expect(result.createdAt).to.equal(null);
      expect(result.updatedAt).to.equal(undefined);
    });
  });
});
