/* eslint-disable header/header */
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
  resolveProject,
  resolveProjectsForPrompt,
  listProjectsForBrand,
  describeProject,
  loadMatrix,
  MatrixNotConfiguredError,
} from '../../../src/support/serenity/matrix.js';

const BRAND = 'b-1';
const FIXTURE = {
  workspaceId: 'ws-1',
  rows: [
    {
      brandId: BRAND, category: 'SEO', market: 'US', language: 'en', projectId: 'p-us-en', slug: 'seo_us_en',
    },
    {
      brandId: BRAND, category: 'SEO', market: 'UK', language: 'en', projectId: 'p-uk-en', slug: 'seo_uk_en',
    },
    {
      brandId: BRAND, category: 'SEO', market: 'DE', language: 'de', projectId: 'p-de-de', slug: 'seo_de_de',
    },
    {
      brandId: 'b-other', category: 'SEO', market: 'US', language: 'en', projectId: 'p-other', slug: 'seo_us_en',
    },
  ],
};

function envWith(matrix) {
  return { SEMRUSH_PROJECT_MATRIX: JSON.stringify(matrix) };
}

describe('serenity/matrix', () => {
  describe('loadMatrix', () => {
    it('reads from SEMRUSH_PROJECT_MATRIX env var when set', () => {
      const { workspaceId, rows } = loadMatrix(envWith(FIXTURE));
      expect(workspaceId).to.equal('ws-1');
      expect(rows).to.have.lengthOf(4);
    });

    it('returns the static fallback when env var is absent', () => {
      const { workspaceId, rows } = loadMatrix({});
      expect(workspaceId).to.equal('');
      expect(rows).to.deep.equal([]);
    });

    it('throws MatrixNotConfiguredError when env var is unparseable', () => {
      expect(() => loadMatrix({ SEMRUSH_PROJECT_MATRIX: 'not-json' }))
        .to.throw(MatrixNotConfiguredError);
    });
  });

  describe('resolveProject', () => {
    it('resolves a configured (brand, category, market, language) tuple', () => {
      const env = envWith(FIXTURE);
      const r = resolveProject(env, BRAND, { category: 'SEO', market: 'US', language: 'en' });
      expect(r).to.deep.equal({ workspaceId: 'ws-1', projectId: 'p-us-en', slug: 'seo_us_en' });
    });

    it('normalizes market case and language case', () => {
      const env = envWith(FIXTURE);
      const r = resolveProject(env, BRAND, { category: 'SEO', market: 'us', language: 'EN' });
      expect(r?.projectId).to.equal('p-us-en');
    });

    it('returns null for an unmapped tuple', () => {
      const env = envWith(FIXTURE);
      const r = resolveProject(env, BRAND, { category: 'SEO', market: 'FR', language: 'fr' });
      expect(r).to.equal(null);
    });

    it('throws when the matrix is empty (no workspaceId)', () => {
      expect(() => resolveProject({}, BRAND, { category: 'SEO', market: 'US', language: 'en' }))
        .to.throw(MatrixNotConfiguredError);
    });
  });

  describe('resolveProjectsForPrompt', () => {
    it('fans out across regions and reports skipped ones', () => {
      const env = envWith(FIXTURE);
      const { matched, skipped } = resolveProjectsForPrompt(env, BRAND, {
        category: 'SEO',
        regions: ['US', 'UK', 'FR'],
        language: 'en',
      });
      expect(matched.map((p) => p.projectId)).to.deep.equal(['p-us-en', 'p-uk-en']);
      expect(skipped).to.have.lengthOf(1);
      expect(skipped[0]).to.include({ market: 'FR', language: 'en' });
    });
  });

  describe('listProjectsForBrand', () => {
    it('filters by brandId and dedupes by projectId', () => {
      const env = envWith(FIXTURE);
      const projects = listProjectsForBrand(env, BRAND);
      const ids = projects.map((p) => p.projectId);
      expect(ids).to.have.members(['p-us-en', 'p-uk-en', 'p-de-de']);
      expect(ids).to.not.include('p-other');
    });
  });

  describe('describeProject', () => {
    it('returns project metadata when present', () => {
      const env = envWith(FIXTURE);
      const project = describeProject(env, BRAND, 'p-uk-en');
      expect(project).to.include({ market: 'UK', language: 'en', category: 'SEO' });
    });

    it('returns null for unknown project id', () => {
      const env = envWith(FIXTURE);
      expect(describeProject(env, BRAND, 'unknown')).to.equal(null);
    });
  });
});
