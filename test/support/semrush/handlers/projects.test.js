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

/* eslint-disable max-len -- Semrush projects handler tests */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  resolveLocation,
  clearLanguageCache,
  handleListProjects,
  handleCreateProject,
  handleListProjectTags,
  handleListProjectModels,
  handleListWorkspaceProjects,
} from '../../../../src/support/semrush/handlers/projects.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

function makeProject({
  semrushProjectId, semrushLocationId, language, createdAt, updatedAt,
}) {
  return {
    getSemrushProjectId: () => semrushProjectId,
    getSemrushLocationId: () => semrushLocationId,
    getLanguage: () => language,
    getCreatedAt: () => createdAt,
    getUpdatedAt: () => updatedAt,
  };
}

function makeDataAccess({ projects = [], existingSlice = null, createResult = null } = {}) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
      findBySlice: sinon.stub().resolves(existingSlice),
      create: sinon.stub().resolves(createResult),
    },
  };
}

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  };
}

describe('semrush projects handler', () => {
  beforeEach(() => {
    clearLanguageCache();
  });

  describe('resolveLocation', () => {
    it('maps an ISO-2 code (case-insensitive) to {locationId, locationName}', () => {
      expect(resolveLocation('US')).to.include.keys(['locationId', 'locationName']);
      expect(resolveLocation('us')).to.deep.equal(resolveLocation('US'));
      expect(resolveLocation('US').locationId).to.equal(2840);
    });

    it('returns null for unknown markets and blank input', () => {
      expect(resolveLocation('ZZ')).to.equal(null);
      expect(resolveLocation('')).to.equal(null);
      expect(resolveLocation(null)).to.equal(null);
    });
  });

  describe('handleListProjects', () => {
    it('returns empty result when brand has no mapped rows', async () => {
      const transport = { listWorkspaceProjects: sinon.stub() };
      const result = await handleListProjects(transport, makeDataAccess(), BRAND, WORKSPACE, {});
      expect(result.items).to.deep.equal([]);
      expect(transport.listWorkspaceProjects).to.not.have.been.called;
    });

    it('enriches DB rows with live Semrush metadata', async () => {
      const projects = [
        makeProject({
          semrushProjectId: 'proj-1', semrushLocationId: 2840, language: 'en',
        }),
      ];
      const transport = {
        listWorkspaceProjects: sinon.stub().resolves({
          items: [{ id: 'proj-1', name: 'Adobe US', domain: 'adobe.com' }],
        }),
      };
      const result = await handleListProjects(transport, makeDataAccess({ projects }), BRAND, WORKSPACE, {});
      expect(result.items).to.have.length(1);
      expect(result.items[0]).to.include({
        semrushProjectId: 'proj-1',
        name: 'Adobe US',
        domain: 'adobe.com',
        workspaceId: WORKSPACE,
      });
    });

    it('returns rows without enrichment when upstream transport fails — marks enrichment:failed', async () => {
      const projects = [
        makeProject({
          semrushProjectId: 'proj-1', semrushLocationId: 2840, language: 'en',
        }),
      ];
      // Use a SemrushTransportError shape so the handler's narrow catch picks it up.
      const upstreamErr = Object.assign(new Error('upstream-down'), { name: 'SemrushTransportError' });
      const transport = {
        listWorkspaceProjects: sinon.stub().rejects(upstreamErr),
      };
      const result = await handleListProjects(transport, makeDataAccess({ projects }), BRAND, WORKSPACE, {}, fakeLog());
      expect(result.items[0].semrushProjectId).to.equal('proj-1');
      expect(result.items[0].name).to.equal(null);
      expect(result.enrichment).to.equal('failed');
    });

    it('lets non-transport errors propagate (real bugs are not silenced)', async () => {
      const projects = [
        makeProject({
          semrushProjectId: 'proj-1', semrushLocationId: 2840, language: 'en',
        }),
      ];
      const transport = {
        // Plain Error (no name='SemrushTransportError') — represents a TypeError
        // / programming bug, not an upstream outage.
        listWorkspaceProjects: sinon.stub().rejects(new TypeError('boom')),
      };
      let caught;
      try {
        await handleListProjects(transport, makeDataAccess({ projects }), BRAND, WORKSPACE, {}, fakeLog());
      } catch (e) {
        caught = e;
      }
      expect(caught).to.be.instanceOf(TypeError);
    });

    it('filters by semrushLocationId and language query params', async () => {
      const projects = [
        makeProject({
          semrushProjectId: 'p-us', semrushLocationId: 2840, language: 'en',
        }),
        makeProject({
          semrushProjectId: 'p-de', semrushLocationId: 2276, language: 'de',
        }),
      ];
      const transport = {
        listWorkspaceProjects: sinon.stub().resolves({ items: [] }),
      };
      const result = await handleListProjects(
        transport,
        makeDataAccess({ projects }),
        BRAND,
        WORKSPACE,
        { semrushLocationId: 2276, language: 'de' },
      );
      expect(result.items.map((p) => p.semrushProjectId)).to.deep.equal(['p-de']);
    });

    it('language filter alone drops non-matching slices', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p-us-en', semrushLocationId: 2840, language: 'en' }),
        makeProject({ semrushProjectId: 'p-us-de', semrushLocationId: 2840, language: 'de' }),
      ];
      const transport = {
        listWorkspaceProjects: sinon.stub().resolves({ items: [] }),
      };
      const result = await handleListProjects(
        transport,
        makeDataAccess({ projects }),
        BRAND,
        WORKSPACE,
        { language: 'en' }, // no locationId filter — only language branch fires
      );
      expect(result.items.map((p) => p.semrushProjectId)).to.deep.equal(['p-us-en']);
    });

    it('returns empty when filter excludes all rows', async () => {
      const projects = [
        makeProject({
          semrushProjectId: 'p-us', semrushLocationId: 2840, language: 'en',
        }),
      ];
      const transport = { listWorkspaceProjects: sinon.stub() };
      const result = await handleListProjects(
        transport,
        makeDataAccess({ projects }),
        BRAND,
        WORKSPACE,
        { semrushLocationId: 9999 },
      );
      expect(result.items).to.deep.equal([]);
      expect(transport.listWorkspaceProjects).to.not.have.been.called;
    });
  });

  describe('handleCreateProject', () => {
    function validBody(overrides = {}) {
      return {
        name: 'Adobe US EN',
        market: 'US',
        language: 'en',
        brandDomain: 'adobe.com',
        brandNames: ['Adobe', 'Adobe Inc.'],
        ...overrides,
      };
    }

    it('400s on missing required fields', async () => {
      const transport = {};
      const dataAccess = makeDataAccess();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, {});
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidRequest');
      expect(result.body.messages.length).to.be.greaterThan(0);
    });

    it('400s on unknown market', async () => {
      const transport = {};
      const dataAccess = makeDataAccess();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody({ market: 'ZZ' }));
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('unknownMarket');
    });

    it('409s when slice already exists, before any upstream call', async () => {
      const existing = {
        getSemrushProjectId: () => 'already-here',
      };
      const transport = {
        createProject: sinon.stub(),
        listLanguages: sinon.stub(),
        publishProject: sinon.stub(),
      };
      const dataAccess = makeDataAccess({ existingSlice: existing });
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody());
      expect(result.status).to.equal(409);
      expect(result.body.semrushProjectId).to.equal('already-here');
      expect(transport.createProject).to.not.have.been.called;
      expect(transport.listLanguages).to.not.have.been.called;
    });

    it('400s on language not in Semrush catalog', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
      };
      const dataAccess = makeDataAccess();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody({ language: 'xx' }));
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('unknownLanguage');
    });

    it('happy path: upstream create+publish+row written, returns 201', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({ id: 'new-proj-1' }),
        publishProject: sinon.stub().resolves({}),
      };
      const dataAccess = makeDataAccess();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody());
      expect(result.status).to.equal(201);
      expect(result.body).to.deep.include({
        semrushProjectId: 'new-proj-1',
        semrushLocationId: 2840,
        language: 'en',
        workspaceId: WORKSPACE,
        name: 'Adobe US EN',
      });
      // Row written exactly once, after both upstream calls succeeded.
      expect(dataAccess.BrandSemrushProject.create).to.have.been.calledOnce;
      const createArg = dataAccess.BrandSemrushProject.create.firstCall.args[0];
      expect(createArg).to.deep.equal({
        brandId: BRAND,
        semrushProjectId: 'new-proj-1',
        semrushLocationId: 2840,
        language: 'en',
      });
      // Upstream body shape is what Semrush expects.
      const upstreamBody = transport.createProject.firstCall.args[1];
      expect(upstreamBody).to.deep.include({
        type: 'aio',
        country_code: 'us',
        location_id: 2840,
        language_id: 'lang-en-uuid',
      });
      expect(upstreamBody.brand_name_display).to.equal('Adobe');
      expect(upstreamBody.brand_names).to.deep.equal(['Adobe', 'Adobe Inc.']);
    });

    it('502 envelope when create returns no id; no row written', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({}),
        publishProject: sinon.stub(),
      };
      const dataAccess = makeDataAccess();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody());
      expect(result.status).to.equal(502);
      expect(dataAccess.BrandSemrushProject.create).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('propagates upstream error from createProject; no row written', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().rejects(new Error('upstream-down')),
        publishProject: sinon.stub(),
      };
      const dataAccess = makeDataAccess();
      await expect(handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody())).to.be.rejectedWith('upstream-down');
      expect(dataAccess.BrandSemrushProject.create).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('propagates upstream error from publishProject + logs orphan; no row written', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({ id: 'new-1' }),
        publishProject: sinon.stub().rejects(new Error('publish-down')),
      };
      const dataAccess = makeDataAccess();
      const log = fakeLog();
      await expect(handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody(), log))
        .to.be.rejectedWith('publish-down');
      expect(dataAccess.BrandSemrushProject.create).to.not.have.been.called;
      // The orphan id MUST be logged so operators can clean up.
      expect(log.error).to.have.been.calledOnce;
      const [msg, ctx] = log.error.firstCall.args;
      expect(msg).to.match(/orphaned upstream Semrush project after publish failure/);
      expect(ctx).to.include({
        brandId: BRAND, workspaceId: WORKSPACE, semrushProjectId: 'new-1',
      });
    });

    it('TOCTOU race: row INSERT fails -> log orphan + return 409 with winner id', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({ id: 'loser-pid' }),
        publishProject: sinon.stub().resolves({}),
      };
      const winner = { getSemrushProjectId: () => 'winner-pid' };
      const dataAccess = {
        BrandSemrushProject: {
          allByBrandId: sinon.stub().resolves([]),
          // First findBySlice (the 409 gate) sees nothing; the create call
          // fails (race partner won); the second findBySlice returns winner.
          findBySlice: sinon.stub().onFirstCall().resolves(null)
            .onSecondCall()
            .resolves(winner),
          create: sinon.stub().rejects(new Error('unique_violation')),
        },
      };
      const log = fakeLog();
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody(), log);
      expect(result.status).to.equal(409);
      expect(result.body.error).to.equal('sliceExists');
      expect(result.body.semrushProjectId).to.equal('winner-pid');
      // Orphan from our (losing) create must be logged.
      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.match(/orphaned upstream Semrush project after row-create race/);
    });

    it('TOCTOU race with no winner found returns 409 with empty semrushProjectId', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({ id: 'loser-pid' }),
        publishProject: sinon.stub().resolves({}),
      };
      const dataAccess = {
        BrandSemrushProject: {
          allByBrandId: sinon.stub().resolves([]),
          findBySlice: sinon.stub().resolves(null),
          create: sinon.stub().rejects(new Error('unique_violation')),
        },
      };
      const result = await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody(), fakeLog());
      expect(result.status).to.equal(409);
      expect(result.body.semrushProjectId).to.equal('');
    });

    it('400s on projectType !== "aio"', async () => {
      const result = await handleCreateProject({}, makeDataAccess(), BRAND, WORKSPACE, validBody({ projectType: 'something-else' }));
      expect(result.status).to.equal(400);
      expect(result.body.messages.join(' ')).to.include('projectType');
    });

    it('warn-logs when the language catalog returns no usable tags', async () => {
      // Items have neither `code`/`iso`/`tag` — cache stays empty → unknownLanguage.
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', label: 'English' }],
        }),
      };
      const log = fakeLog();
      const result = await handleCreateProject(transport, makeDataAccess(), BRAND, WORKSPACE, validBody(), log);
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('unknownLanguage');
      expect(log.warn).to.have.been.called;
      const [msg] = log.warn.firstCall.args;
      expect(msg).to.match(/no usable tags/);
    });

    it('caches the language catalog across calls within TTL', async () => {
      const transport = {
        listLanguages: sinon.stub().resolves({
          items: [{ id: 'lang-en-uuid', code: 'en' }],
        }),
        createProject: sinon.stub().resolves({ id: 'p1' }),
        publishProject: sinon.stub().resolves({}),
      };
      const dataAccess = makeDataAccess();
      await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody());
      // Reset slice gate so the second call goes past the 409.
      dataAccess.BrandSemrushProject.findBySlice.resolves(null);
      await handleCreateProject(transport, dataAccess, BRAND, WORKSPACE, validBody({
        market: 'DE',
        language: 'en',
      }));
      expect(transport.listLanguages).to.have.been.calledOnce;
    });
  });

  describe('handleListProjectTags', () => {
    it('collects unique tags across pages, sorts by name', async () => {
      const transport = {
        listPromptsByTags: sinon.stub(),
      };
      transport.listPromptsByTags.onCall(0).resolves({
        items: Array.from({ length: 200 }).map((_, i) => ({
          id: `s${i}`,
          name: `q${i}`,
          tags: [{ id: 't1', name: 'Topic-A' }, { id: 't2', name: 'Topic-B' }],
        })),
      });
      transport.listPromptsByTags.onCall(1).resolves({
        items: [{ id: 's-last', name: 'last', tags: [{ id: 't3', name: 'Topic-C' }] }],
      });
      const result = await handleListProjectTags(transport, WORKSPACE, 'proj-1');
      expect(result.items.map((t) => t.name)).to.deep.equal(['Topic-A', 'Topic-B', 'Topic-C']);
    });

    it('accepts string-typed tags as both id and name', async () => {
      const transport = {
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 's', name: 'p', tags: ['raw-tag'] }],
        }),
      };
      const result = await handleListProjectTags(transport, WORKSPACE, 'proj-1');
      expect(result.items).to.deep.equal([{ id: 'raw-tag', name: 'raw-tag' }]);
    });

    it('stops at first short page', async () => {
      const transport = {
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 's', name: 'p', tags: [{ id: 't', name: 'T' }] }],
        }),
      };
      const result = await handleListProjectTags(transport, WORKSPACE, 'proj-1');
      expect(result.items).to.have.length(1);
      expect(transport.listPromptsByTags).to.have.been.calledOnce;
    });
  });

  describe('handleListProjectModels', () => {
    it('flattens model objects to {id, key, name, icon}', async () => {
      const transport = {
        listAiModels: sinon.stub().resolves({
          items: [
            {
              model: {
                id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: 'icon',
              },
            },
            { model: { id: 'm2', key: 'gemini', name: 'Gemini' } },
            { not_a_model: true },
            { model: { id: '', key: 'broken' } },
          ],
        }),
      };
      const result = await handleListProjectModels(transport, WORKSPACE, 'proj-1');
      expect(result.items).to.have.length(2);
      expect(result.items[0].key).to.equal('gpt-4o');
    });

    it('paginates upstream pages until a short page is returned', async () => {
      // Page 1 returns a full 100; page 2 returns 3 (short → stop).
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        model: { id: `m${i}`, key: `k${i}`, name: `n${i}` },
      }));
      const shortPage = Array.from({ length: 3 }, (_, i) => ({
        model: { id: `m100${i}`, key: `k100${i}`, name: `n100${i}` },
      }));
      const transport = { listAiModels: sinon.stub() };
      transport.listAiModels.onCall(0).resolves({ items: fullPage });
      transport.listAiModels.onCall(1).resolves({ items: shortPage });
      const result = await handleListProjectModels(transport, WORKSPACE, 'proj-1');
      expect(result.items.length).to.equal(103);
      expect(transport.listAiModels).to.have.been.calledTwice;
    });

    it('stops on first empty page', async () => {
      const transport = { listAiModels: sinon.stub().resolves({ items: [] }) };
      const result = await handleListProjectModels(transport, WORKSPACE, 'proj-1');
      expect(result.items).to.deep.equal([]);
      expect(transport.listAiModels).to.have.been.calledOnce;
    });
  });

  describe('handleListWorkspaceProjects', () => {
    it('returns {id, name, domain} per project under the items envelope', async () => {
      const transport = {
        listWorkspaceProjects: sinon.stub().resolves({
          items: [
            { id: 'p1', name: 'one', domain: 'one.com' },
            { id: '', name: 'broken' },
            { id: 'p2', name: 'two', domain: 'two.com' },
          ],
        }),
      };
      const result = await handleListWorkspaceProjects(transport, WORKSPACE);
      expect(result.items).to.deep.equal([
        { id: 'p1', name: 'one', domain: 'one.com' },
        { id: 'p2', name: 'two', domain: 'two.com' },
      ]);
    });

    it('paginates across multiple workspace pages', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
      const shortPage = [{ id: 'p100', name: 'last' }];
      const transport = { listWorkspaceProjects: sinon.stub() };
      transport.listWorkspaceProjects.onCall(0).resolves({ items: fullPage });
      transport.listWorkspaceProjects.onCall(1).resolves({ items: shortPage });
      const result = await handleListWorkspaceProjects(transport, WORKSPACE);
      expect(result.items).to.have.length(101);
      expect(transport.listWorkspaceProjects).to.have.been.calledTwice;
    });

    it('stops on the first empty page', async () => {
      const transport = { listWorkspaceProjects: sinon.stub().resolves({ items: [] }) };
      const result = await handleListWorkspaceProjects(transport, WORKSPACE);
      expect(result.items).to.deep.equal([]);
      expect(transport.listWorkspaceProjects).to.have.been.calledOnce;
    });
  });
});
