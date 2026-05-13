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
import sinon from 'sinon';
import {
  encodeLogicalId,
  decodeLogicalId,
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../../../../src/support/serenity/handlers/prompts.js';

const BRAND = 'b-1';
const FIXTURE = {
  workspaceId: 'ws-1',
  rows: [
    {
      brandId: BRAND, category: 'SEO', market: 'US', language: 'en', projectId: 'p-us-en',
    },
    {
      brandId: BRAND, category: 'SEO', market: 'UK', language: 'en', projectId: 'p-uk-en',
    },
    {
      brandId: BRAND, category: 'SEO', market: 'DE', language: 'de', projectId: 'p-de-de',
    },
  ],
};
const ENV = { SEMRUSH_PROJECT_MATRIX: JSON.stringify(FIXTURE) };

function makeTransport() {
  return {
    listPromptsByTags: sinon.stub(),
    createTaggedPrompts: sinon.stub(),
    deletePromptsByIds: sinon.stub(),
  };
}

describe('serenity/handlers/prompts', () => {
  describe('logical id codec', () => {
    it('round-trips a logical id', () => {
      const id = encodeLogicalId({
        brandId: BRAND, category: 'SEO', language: 'en', text: 'best seo tools',
      });
      expect(decodeLogicalId(id)).to.deep.equal({
        brandId: BRAND, category: 'SEO', language: 'en', text: 'best seo tools',
      });
    });

    it('returns null for malformed ids', () => {
      expect(decodeLogicalId('not-base64')).to.equal(null);
    });
  });

  describe('handleListPrompts', () => {
    it('aggregates across matrix projects, grouping by (text, lang, cat)', async () => {
      const transport = makeTransport();
      // p-us-en returns the same prompt text as p-uk-en
      transport.listPromptsByTags.withArgs('ws-1', 'p-us-en').resolves({
        items: [
          { id: 'us-1', name: 'best seo tools', tags: [{ id: 't1', name: 'general' }] },
        ],
        total: 1,
        page: 1,
      });
      transport.listPromptsByTags.withArgs('ws-1', 'p-uk-en').resolves({
        items: [
          { id: 'uk-1', name: 'best seo tools', tags: [{ id: 't1', name: 'general' }] },
        ],
        total: 1,
        page: 1,
      });
      transport.listPromptsByTags.withArgs('ws-1', 'p-de-de').resolves({
        items: [
          { id: 'de-1', name: 'beste seo werkzeuge', tags: [] },
        ],
        total: 1,
        page: 1,
      });

      const result = await handleListPrompts(transport, ENV, BRAND, {});

      expect(result.total).to.equal(2);
      const seoTools = result.items.find((i) => i.text === 'best seo tools');
      expect(seoTools.regions.sort()).to.deep.equal(['UK', 'US']);
      expect(seoTools.projects).to.have.lengthOf(2);
      const deutsch = result.items.find((i) => i.text === 'beste seo werkzeuge');
      expect(deutsch.language).to.equal('de');
      expect(deutsch.regions).to.deep.equal(['DE']);
    });

    it('honors region/language/category filters at the project level', async () => {
      const transport = makeTransport();
      transport.listPromptsByTags.resolves({ items: [], total: 0, page: 1 });
      await handleListPrompts(transport, ENV, BRAND, { region: 'us' });
      expect(transport.listPromptsByTags.callCount).to.equal(1);
      expect(transport.listPromptsByTags.firstCall.args[1]).to.equal('p-us-en');
    });

    it('returns partial results when one project upstream errors', async () => {
      const transport = makeTransport();
      transport.listPromptsByTags.withArgs('ws-1', 'p-us-en').resolves({
        items: [{ id: 'x', name: 't1', tags: [] }], total: 1, page: 1,
      });
      transport.listPromptsByTags.withArgs('ws-1', 'p-uk-en').rejects(new Error('500 boom'));
      transport.listPromptsByTags.withArgs('ws-1', 'p-de-de').resolves({
        items: [], total: 0, page: 1,
      });
      const result = await handleListPrompts(transport, ENV, BRAND, {});
      expect(result.items).to.have.lengthOf(1);
      expect(result.errors).to.have.lengthOf(1);
      expect(result.errors[0].message).to.include('boom');
    });
  });

  describe('handleCreatePrompts', () => {
    it('fans a multi-region prompt across matrix projects', async () => {
      const transport = makeTransport();
      transport.createTaggedPrompts.callsFake((ws, pid) => Promise.resolve({
        ids: [`new-${pid}`], existing_count: 0,
      }));

      const result = await handleCreatePrompts(transport, ENV, BRAND, {
        prompts: [{
          text: 'best seo tools',
          category: 'SEO',
          language: 'en',
          regions: ['US', 'UK'],
          topic: 'general',
        }],
      });

      expect(transport.createTaggedPrompts.callCount).to.equal(2);
      expect(result.created).to.have.lengthOf(1);
      const created = result.created[0];
      expect(created.regions.sort()).to.deep.equal(['UK', 'US']);
      expect(created.projects.map((p) => p.projectId).sort()).to.deep.equal(['p-uk-en', 'p-us-en']);
      expect(created.projects.every((p) => p.semrushPromptId)).to.equal(true);
    });

    it('records per-project errors when one fanout call fails', async () => {
      const transport = makeTransport();
      transport.createTaggedPrompts
        .withArgs('ws-1', 'p-us-en').resolves({ ids: ['ok'], existing_count: 0 })
        .withArgs('ws-1', 'p-uk-en').rejects(new Error('upstream 500'));

      const result = await handleCreatePrompts(transport, ENV, BRAND, {
        prompts: [{
          text: 't', category: 'SEO', language: 'en', regions: ['US', 'UK'],
        }],
      });

      const created = result.created[0];
      const ukResult = created.projects.find((p) => p.projectId === 'p-uk-en');
      expect(ukResult.error.message).to.include('upstream 500');
      const usResult = created.projects.find((p) => p.projectId === 'p-us-en');
      expect(usResult.semrushPromptId).to.equal('ok');
    });

    it('rejects prompts missing required fields', async () => {
      const transport = makeTransport();
      const result = await handleCreatePrompts(transport, ENV, BRAND, {
        prompts: [{ text: 'has no category', language: 'en', regions: ['US'] }],
      });
      expect(result.created).to.deep.equal([]);
      expect(result.errors).to.have.lengthOf(1);
      expect(transport.createTaggedPrompts.called).to.equal(false);
    });

    it('rejects prompts where no region maps in the matrix', async () => {
      const transport = makeTransport();
      const result = await handleCreatePrompts(transport, ENV, BRAND, {
        prompts: [{
          text: 't', category: 'SEO', language: 'fr', regions: ['FR'],
        }],
      });
      expect(result.errors[0].skipped).to.have.lengthOf(1);
      expect(transport.createTaggedPrompts.called).to.equal(false);
    });
  });

  describe('handleBulkDeletePrompts', () => {
    it('groups deletes by project and forwards per-project ids', async () => {
      const transport = makeTransport();
      transport.deletePromptsByIds.resolves(null);
      const result = await handleBulkDeletePrompts(transport, ENV, BRAND, {
        targets: [
          { projectId: 'p-us-en', semrushPromptId: 'a' },
          { projectId: 'p-us-en', semrushPromptId: 'b' },
          { projectId: 'p-uk-en', semrushPromptId: 'c' },
        ],
      });
      expect(transport.deletePromptsByIds.callCount).to.equal(2);
      const usCall = transport.deletePromptsByIds.getCalls()
        .find((c) => c.args[1] === 'p-us-en');
      expect(usCall.args[2].sort()).to.deep.equal(['a', 'b']);
      expect(result.deleted).to.equal(3);
    });

    it('reports an error for targets whose projectId is not in the matrix', async () => {
      const transport = makeTransport();
      const result = await handleBulkDeletePrompts(transport, ENV, BRAND, {
        targets: [{ projectId: 'p-unknown', semrushPromptId: 'x' }],
      });
      expect(result.errors).to.have.lengthOf(1);
      expect(result.errors[0].status).to.equal(404);
    });
  });

  describe('handleUpdatePrompt', () => {
    it('rejects when logicalId is not for the requested brand', async () => {
      const id = encodeLogicalId({
        brandId: 'b-other', category: 'SEO', language: 'en', text: 't',
      });
      const result = await handleUpdatePrompt(makeTransport(), ENV, BRAND, id, {
        projects: [{ projectId: 'p-us-en', semrushPromptId: 'x', market: 'US' }],
      });
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidLogicalId');
    });

    it('rejects when projects array is missing', async () => {
      const id = encodeLogicalId({
        brandId: BRAND, category: 'SEO', language: 'en', text: 't',
      });
      const result = await handleUpdatePrompt(makeTransport(), ENV, BRAND, id, {});
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('missingProjects');
    });

    it('deletes old per-project ids then creates on the new region set', async () => {
      const transport = makeTransport();
      transport.deletePromptsByIds.resolves(null);
      transport.createTaggedPrompts.callsFake((ws, pid) => Promise.resolve({
        ids: [`new-${pid}`],
      }));

      const id = encodeLogicalId({
        brandId: BRAND, category: 'SEO', language: 'en', text: 'old',
      });
      const result = await handleUpdatePrompt(transport, ENV, BRAND, id, {
        projects: [
          { projectId: 'p-us-en', semrushPromptId: 'x1', market: 'US' },
        ],
        text: 'new text',
        regions: ['US', 'UK'],
      });

      expect(result.status).to.equal(200);
      expect(transport.deletePromptsByIds.calledOnce).to.equal(true);
      expect(transport.createTaggedPrompts.callCount).to.equal(2);
      expect(result.body.updated.text).to.equal('new text');
      expect(result.body.updated.regions.sort()).to.deep.equal(['UK', 'US']);
    });
  });
});
