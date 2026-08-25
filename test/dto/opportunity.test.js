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
import { OpportunityDto } from '../../src/dto/opportunity.js';

describe('OpportunityDto', () => {
  const createMockOppty = (dataOverrides = {}, opptyOverrides = {}) => ({
    getId: () => 'oppty-id-123',
    getSiteId: () => 'site-id-456',
    getAuditId: () => 'audit-id-789',
    getRunbook: () => 'http://runbook.url',
    getType: () => 'youtube-analysis',
    getData: () => ({ someField: 'value', ...dataOverrides }),
    getOrigin: () => 'ESS_OPS',
    getTitle: () => opptyOverrides.title ?? 'English title',
    getDescription: () => opptyOverrides.description ?? 'English description',
    getGuidance: () => ({ steps: [] }),
    getTags: () => ['video content'],
    getStatus: () => 'NEW',
    getCreatedAt: () => '2025-01-01T00:00:00.000Z',
    getUpdatedAt: () => '2025-01-02T00:00:00.000Z',
    getUpdatedBy: () => 'system',
    getLastAuditedAt: () => '2025-01-01T00:00:00.000Z',
  });

  describe('toJSON', () => {
    it('returns all standard fields without locale', () => {
      const oppty = createMockOppty();

      const json = OpportunityDto.toJSON(oppty);

      expect(json).to.have.property('id', 'oppty-id-123');
      expect(json).to.have.property('siteId', 'site-id-456');
      expect(json).to.have.property('title', 'English title');
      expect(json).to.have.property('description', 'English description');
      expect(json).to.have.property('data');
      expect(json.data).to.have.property('someField', 'value');
    });

    describe('locale projection', () => {
      it('returns original English when no locale is provided', () => {
        const oppty = createMockOppty({
          i18n: { fr_fr: { title: 'Titre français', description: 'Description française' } },
        });

        const json = OpportunityDto.toJSON(oppty);

        expect(json.title).to.equal('English title');
        expect(json.description).to.equal('English description');
        expect(json.data).to.not.have.property('i18n');
      });

      it('promotes locale-specific title and description when locale matches', () => {
        const oppty = createMockOppty({
          i18n: {
            fr_fr: { title: 'Titre français', description: 'Description française' },
          },
        });

        const json = OpportunityDto.toJSON(oppty, 'fr_fr');

        expect(json.title).to.equal('Titre français');
        expect(json.description).to.equal('Description française');
        expect(json.data).to.not.have.property('i18n');
        expect(json.data).to.have.property('someField', 'value');
      });

      it('falls back to English when locale has no stored translation', () => {
        const oppty = createMockOppty({
          i18n: { fr_fr: { title: 'Titre français', description: 'Description française' } },
        });

        const json = OpportunityDto.toJSON(oppty, 'ja_jp');

        expect(json.title).to.equal('English title');
        expect(json.description).to.equal('English description');
      });

      it('promotes only the fields present in the locale translation', () => {
        const oppty = createMockOppty({
          i18n: { fr_fr: { title: 'Titre français' } },
        });

        const json = OpportunityDto.toJSON(oppty, 'fr_fr');

        expect(json.title).to.equal('Titre français');
        expect(json.description).to.equal('English description');
      });

      it('strips i18n key from data even without locale param', () => {
        const oppty = createMockOppty({
          i18n: { fr_fr: { title: 'Titre français' } },
        });

        const json = OpportunityDto.toJSON(oppty);

        expect(json.data).to.not.have.property('i18n');
        expect(json.data).to.have.property('someField', 'value');
      });

      it('handles getData returning null gracefully', () => {
        const oppty = {
          ...createMockOppty(),
          getData: () => null,
        };

        const json = OpportunityDto.toJSON(oppty, 'fr_fr');

        expect(json.title).to.equal('English title');
        expect(json.description).to.equal('English description');
        expect(json.data).to.be.null;
      });

      it('handles getData returning empty object gracefully', () => {
        const oppty = {
          ...createMockOppty(),
          getData: () => ({}),
        };

        const json = OpportunityDto.toJSON(oppty, 'fr_fr');

        expect(json.title).to.equal('English title');
        expect(json.data).to.deep.equal({});
      });
    });
  });
});
