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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
  makeTypeInjector,
} from '../../../../src/support/serenity/handlers/prompts.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import {
  TAG_IDS,
  dimensionTreeLevels,
  makeListProjectTagsStub,
  makeProvisioningTransportStubs,
} from '../fixtures/tag-tree.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

// A classifier over BARE `type` values — the dimension is the tag's root, never
// a prefix on its name.
const classifyByBrandMention = (text) => (/\bacme\b/i.test(text) ? 'branded' : 'non-branded');

function makeProject({ semrushProjectId, geoTargetId, languageCode }) {
  return {
    getSemrushProjectId: () => semrushProjectId,
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
  };
}

function makeDataAccess(projects) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
      findBySlice: sinon.stub(),
    },
  };
}

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  };
}

describe('handlers/prompts.js — handleListPrompts', () => {
  it('400s when geoTargetId is missing', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    await expect(handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      languageCode: 'en',
    })).to.be.rejectedWith(ErrorWithStatusCode);
  });

  it('400s when languageCode is missing', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    await expect(handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840,
    })).to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Minor #6 from review: malformed languageCode must 400 before "no market
  // for slice" 404 short-circuits. Locks the b8281e81 behavior change for
  // handleListPrompts (counterpart tests for tags + models live in
  // markets.test.js).
  it('400s on syntactically malformed languageCode (`ENG-X`)', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    await expect(handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840,
      languageCode: 'ENG-X',
    })).to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Important #4 from review: missing slice on a single-slice handler emits
  // 404 marketNotFound — same precondition as handleUpdatePrompt, same
  // contract. Old shape (empty 200) silently rendered the same body as
  // "slice exists, has no prompts", hiding a renamed/stale market.
  it('throws 404 marketNotFound when no market exists for the slice', async () => {
    const transport = { listPromptsByTags: sinon.stub() };
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);

    try {
      await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
        geoTargetId: 2840, languageCode: 'en',
      });
      expect.fail('expected ErrorWithStatusCode 404');
    } catch (e) {
      expect(e).to.be.instanceOf(ErrorWithStatusCode);
      expect(e.status).to.equal(404);
      expect(e.code).to.equal('marketNotFound');
    }
    expect(transport.listPromptsByTags).not.to.have.been.called;
  });

  // Branch coverage: defensive defaults across the handler — exercises every
  // short-circuit that protects the response shape from a malformed upstream
  // payload (missing items/total fields, object-form tags, null id, non-string
  // tag entries, missing query fields).
  it('survives an upstream payload that exercises every defensive default', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        // resp.items missing → Array.isArray(undefined) ? items : [] → []
        // resp.total missing → Number.isFinite(undefined) ? total : items.length → 0
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      // Query missing page/limit/search → defaults: page=1, limit=50, search=undefined.
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result).to.deep.equal({
      items: [], total: 0, page: 1, limit: 50,
    });
  });

  // Branch coverage: object-form tags (`{id, name}`) and null `id` on the
  // prompt — both are valid upstream shapes that must not blow up the DTO.
  it('maps object-form tags and coerces null prompt id to empty string', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        items: [
          // Object-form tag with `name` → tagNamesOf maps to t.name
          { id: null, name: 'no-id', tags: [{ name: 'consideration' }, null, 42] },
        ],
        total: 1,
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en', page: 1, limit: 10, search: '  ',
    });

    expect(result.items[0].semrushPromptId).to.equal('');
    expect(result.items[0].tagMap).to.deep.equal({ consideration: '' });
  });

  // Branch coverage: tagNamesOf handles items with no tags array (DTO carries
  // an empty `tags`), and buildPromptDto returns null on empty text so the
  // filter drops it before it reaches the response — this guarantees the
  // upstream cannot leak an unnamed prompt into the UI list.
  it('skips items with empty text and emits empty tags when upstream omits the array', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        items: [
          { id: 'sem-1', name: 'good prompt' /* tags omitted */ },
          { id: 'sem-bad', name: '' /* empty text — filtered */ },
        ],
        total: 2,
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items).to.have.lengthOf(1);
    expect(result.items[0]).to.deep.equal({
      semrushPromptId: 'sem-1',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'good prompt',
      tags: [],
      tagMap: {},
    });
  });

  it('maps upstream items to SerenityPrompt DTOs without leaking semrushProjectId or synthetic ids', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        items: [
          {
            id: 'sem-1', name: 'What is Adobe?', tags: [{ id: 't-1', name: 'awareness' }],
          },
        ],
        total: 1,
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items[0]).to.deep.equal({
      semrushPromptId: 'sem-1',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'What is Adobe?',
      // A ROOT tag omits parent_id/path upstream, so its parentage is null and
      // its own name is its dimension.
      tags: [{
        id: 't-1', name: 'awareness', parentId: null, path: null,
      }],
      tagMap: { awareness: 't-1' },
    });
    expect(result.items[0]).not.to.have.property('id');
    expect(result.items[0]).not.to.have.property('semrushProjectId');
  });

  // The load-bearing property of the id-keyed `tags` array: a prompt can carry
  // two tags with the same bare name from different dimensions. Upstream embeds
  // each tag's own parentage on the prompt, so the dimension reads straight off
  // `path[0]`. `tagMap`, being name-keyed, can only represent one of them —
  // which is why it is deprecated.
  it('keeps two same-named prompt tags distinct, reading each dimension off its own path', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub(),
      listPromptsByTags: sinon.stub().resolves({
        items: [{
          id: 'sem-1',
          name: 'best trail shoes',
          // Exactly what upstream embeds on a prompt: a descendant carries its
          // own parent_id and root-first path.
          tags: [
            {
              id: TAG_IDS.subCategoryHuman,
              name: 'human',
              children_count: 0,
              parent_id: TAG_IDS.categoryRunningShoes,
              path: [
                { id: TAG_IDS.categoryRoot, name: 'category' },
                { id: TAG_IDS.categoryRunningShoes, name: 'Running Shoes' },
              ],
            },
            {
              id: TAG_IDS.originHuman,
              name: 'human',
              children_count: 0,
              parent_id: TAG_IDS.originRoot,
              path: [{ id: TAG_IDS.originRoot, name: 'origin' }],
            },
          ],
        }],
        total: 1,
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    const { tags } = result.items[0];
    expect(tags).to.have.lengthOf(2);
    expect(tags.map((t) => t.path[0].name)).to.deep.equal(['category', 'origin']);
    expect(tags[0].parentId).to.equal(TAG_IDS.categoryRunningShoes);
    expect(tags[1].parentId).to.equal(TAG_IDS.originRoot);
    // The deprecated name-keyed view collapses them; only one id survives.
    expect(Object.keys(result.items[0].tagMap)).to.deep.equal(['human']);
    // Listing prompts costs exactly ONE upstream call — no tag-tree walk.
    expect(transport.listProjectTags).to.not.have.been.called;
  });

  it('passes tagIds from query to listPromptsByTags when provided', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    };

    await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-uuid-1', 'tag-uuid-2'],
    });

    expect(transport.listPromptsByTags).to.have.been.calledOnce;
    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.tag_ids).to.deep.equal(['tag-uuid-1', 'tag-uuid-2']);
  });

  it('passes empty tag_ids when tagIds is absent', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    };

    await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.tag_ids).to.deep.equal([]);
  });

  it('buildTagMapOf: skips null/non-object entries and objects without name; coerces numeric id', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        items: [{
          id: 'sem-1',
          name: 'prompt',
          tags: [
            null,
            42,
            { id: 'id-only' },
            { name: 'name-only' },
            { name: 'valid', id: 42 },
            '',
            'string-tag',
          ],
        }],
        total: 1,
      }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result.items[0].tagMap).to.deep.equal({
      'name-only': '',
      valid: '42',
      'string-tag': '',
    });
  });

  it('slices tagIds to MAX_TAG_IDS (50) before forwarding', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    };
    const tooMany = Array.from({ length: 55 }, (_, i) => `tag-${i}`);

    await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en', tagIds: tooMany,
    });

    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.tag_ids).to.have.lengthOf(50);
    expect(body.tag_ids[0]).to.equal('tag-0');
    expect(body.tag_ids[49]).to.equal('tag-49');
  });

  it('uses resp.total when returned item count equals the page limit', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ id: `s-${i}`, name: `prompt ${i}` }));
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: fullPage, total: 999 }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en', limit: 10,
    });

    // items.length (10) === limit (10) → use resp.total
    expect(result.total).to.equal(999);
  });

  it('computes exact total from items when on the last (partial) page', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    // 3 items returned, limit=10, page=2 → exact total = (2-1)*10 + 3 = 13
    const partialPage = Array.from({ length: 3 }, (_, i) => ({ id: `s-${i}`, name: `prompt ${i}` }));
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: partialPage, total: 999 }),
    };

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en', limit: 10, page: 2,
    });

    expect(result.total).to.equal(13);
  });
});

describe('handlers/prompts.js — handleCreatePrompts', () => {
  it('400s on empty prompts array (no upstream call)', async () => {
    const transport = { createPromptsByIds: sinon.stub() };
    const dataAccess = makeDataAccess([]);

    await expect(handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [],
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode);
    expect(transport.createPromptsByIds).not.to.have.been.called;
  });

  // Review minor #4: maxItems=500 cap matches the OpenAPI declaration and
  // prevents an authenticated caller from submitting 10k+ items inside API
  // Gateway's request envelope. Defense-in-depth, not a correctness gate.
  it('400s when the prompts array exceeds maxItems=500', async () => {
    const transport = { createPromptsByIds: sinon.stub() };
    const dataAccess = makeDataAccess([]);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({
      text: `prompt ${i}`,
      tagIds: ['tag-1'],
      geoTargetId: 2840,
      languageCode: 'en',
    }));

    await expect(handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: tooMany,
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode, /maxItems=500/);
    expect(transport.createPromptsByIds).not.to.have.been.called;
  });

  // Branch coverage: body with no `prompts` key → Array.isArray fallback to []
  // → 400 fires from the empty-array check.
  it('400s when body has no prompts field at all', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleCreatePrompts({}, dataAccess, BRAND, WORKSPACE, {}, fakeLog()))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Branch coverage: dataAccess returns null for the brand's projects → the
  // `projects || []` fallback kicks in and every input is skipped.
  it('skips every input when allByBrandId returns null', async () => {
    const dataAccess = makeDataAccess(null);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'orphaned', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].reason).to.match(/No market for slice/);
    expect(transport.createPromptsByIds).to.have.callCount(0);
  });

  // Branch coverage: raw input with no `text` field → normalizePromptInput
  // returns null and the row lands in `skipped` with `text: ''`.
  it('skips inputs with no text field (raw.text undefined → empty string)', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'] }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].text).to.equal('');
  });

  // Branch coverage: createPromptsByIds rejects with an error that has no
  // `.status` field → `e.status || 500` defaults to 500.
  it('defaults failed.status to 500 when upstream error has no status property', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().rejects(new Error('opaque failure')),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'will fail', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.failed[0].status).to.equal(500);
  });

  it('skips inputs missing required fields', async () => {
    const transport = { createPromptsByIds: sinon.stub() };
    const dataAccess = makeDataAccess([]);

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ text: 'no slice' }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].text).to.equal('no slice');
  });

  it('creates a prompt by id-based tagIds via aio/prompts and publishes the project', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'hello' }], existing_count: 0,
      }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-cat-1', 'tag-child-1'],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(1);
    expect(result.created[0]).to.deep.equal({
      semrushPromptId: 'new-sem-id',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'hello',
      tagIds: ['tag-cat-1', 'tag-child-1'],
    });
    expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', ['hello'], ['tag-cat-1', 'tag-child-1']);
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
  });

  // A name cannot identify a nested tag: the name-keyed upstream write is
  // root-only, so an unknown name would mint a phantom ROOT tag rather than
  // attach the category the caller meant. A `tags` key is therefore rejected
  // outright — a stale caller must fail loudly, not write garbage.
  it('skips an input that supplies tag NAMES instead of tagIds', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tags: ['Running Shoes'],
      }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(transport.createPromptsByIds).to.not.have.been.called;
  });

  it('skips an input that supplies both tags and tagIds', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tags: ['a'], tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(transport.createPromptsByIds).to.not.have.been.called;
  });

  it('skips an input carrying an empty tags array alongside tagIds (presence-based rejection, not content-based)', async () => {
    // Regression lock for the content-based-vs-presence-based fix: under a
    // `tags.length > 0` check, an explicitly-present-but-empty `tags: []` would
    // not conflict and this input would succeed via the id-based path. Both
    // create and update reject on the KEY being present, matching
    // parseUpdatePromptBody's contract (mirrored 400 test on the update side).
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tags: [], tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(transport.createPromptsByIds).to.not.have.been.called;
  });

  it('drops falsy tagIds entries and returns empty semrushPromptId when createPromptsByIds has no items', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 0, items: [], existing_count: 1,
      }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tagIds: ['keep', '', null],
      }],
    }, fakeLog());

    expect(result.created[0].semrushPromptId).to.equal('');
    expect(result.created[0].tagIds).to.deep.equal(['keep']);
    expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', ['hello'], ['keep']);
  });

  it('returns empty semrushPromptId (not the string "undefined") when createPromptsByIds returns an item with no id', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ name: 'hello' }],
      }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-cat-1'],
      }],
    }, fakeLog());

    expect(result.created[0].semrushPromptId).to.equal('');
  });

  it('drops malformed tagIds entries (too long / whitespace / control char) like validateParentIdFormat does for parentId', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'hello' }],
      }),
      publishProject: sinon.stub().resolves(),
    };
    const tooLong = 'x'.repeat(201);

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello',
        geoTargetId: 2840,
        languageCode: 'en',
        tagIds: ['keep', 'has space', `control${String.fromCharCode(1)}char`, tooLong],
      }],
    }, fakeLog());

    expect(result.created[0].tagIds).to.deep.equal(['keep']);
    expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', ['hello'], ['keep']);
  });

  it('caps a bulk-create tagIds array at MAX_TAG_IDS (50), mirroring the list-read query cap', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'hello' }],
      }),
      publishProject: sinon.stub().resolves(),
    };
    const tooMany = Array.from({ length: 55 }, (_, i) => `tag-${i}`);

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tagIds: tooMany,
      }],
    }, fakeLog());

    expect(result.created[0].tagIds).to.have.lengthOf(50);
    expect(result.created[0].tagIds).to.deep.equal(tooMany.slice(0, 50));
  });

  it('skips a create row when tagIds sanitizes to empty (every entry malformed)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = { createPromptsByIds: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tagIds: ['has space', ''],
      }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(transport.createPromptsByIds).to.not.have.been.called;
  });

  it('skips inputs whose (geoTargetId, languageCode) slice has no row on the brand', async () => {
    const usEn = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'good' }],
      }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        {
          text: 'good', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        },
        {
          text: 'orphan', geoTargetId: 9999, languageCode: 'xx', tagIds: ['tag-1'],
        },
      ],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(1);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0]).to.deep.equal({
      text: 'orphan',
      reason: 'No market for slice (9999, xx)',
    });
    // Only one upstream create — the orphan slice is filtered before any call.
    expect(transport.createPromptsByIds).to.have.callCount(1);
  });

  // Branch coverage: upstream createPromptsByIds rejects → that row enters the
  // `failed` bucket with the upstream error's status code, but the rest of the
  // batch continues.
  it('reports per-input failures when upstream createPromptsByIds rejects', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const transport = {
      createPromptsByIds: sinon.stub().rejects(err),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'will fail', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(0);
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0]).to.deep.equal({
      text: 'will fail',
      geoTargetId: 2840,
      languageCode: 'en',
      status: 429,
      message: 'rate limited',
    });
    // No create succeeded for this project, so publishProject is never called.
    expect(transport.publishProject).to.have.callCount(0);
  });

  // Branch coverage: publishAffected catches per-project errors and surfaces
  // them as 502 entries in `failed` so the client knows the create succeeded
  // upstream but the project never went live.
  it('appends a 502 failure for each publishProject error', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createPromptsByIds: sinon.stub().resolves({
        page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'ok' }],
      }),
      publishProject: sinon.stub().rejects(new Error('publish boom')),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'ok', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(1);
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0]).to.deep.equal({
      text: '',
      status: 502,
      message: 'publish: publish boom',
    });
  });
});

describe('handlers/prompts.js — handleUpdatePrompt', () => {
  // Regression guard for the "drop slow path" decision: PATCH treats the
  // body as the full next state, so omitting either text or tagIds is a
  // client error. Previously omitting tags meant "preserve" and forced a
  // 10k-prompt walk per request — that's now gone, and the missing-field
  // 400 keeps the contract honest.
  it('400s when text is missing from body', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      { geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'] },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('missingFields');
  });

  it('400s when tagIds is missing from body', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      { geoTargetId: 2840, languageCode: 'en', text: 'only text' },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('missingFields');
  });

  // The shape a caller that has not migrated actually sends: the retired `tags`
  // key and NO `tagIds`. The missing-field check must not run first, or the 400
  // names the field the caller never heard of instead of the one it sent.
  it('400s naming `tags` when a legacy body carries tags and no tagIds', async () => {
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tags: ['category:Shoes'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
    expect(result.body.message).to.match(/tags is not supported/);
  });

  // `tags` is rejected on its own, not merely when it collides with `tagIds`:
  // a name is not an address for a nested tag, so honouring it would write a
  // phantom root tag upstream.
  it('400s when tags is present at all, even as null', async () => {
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: ['tag-1'], tags: null,
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('400s when both tags and tagIds are present (mutually exclusive)', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tags: ['a'], tagIds: ['tag-1'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('400s when tagIds is present but not an array', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: 'not-an-array',
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('400s when tagIds is present but empty', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: [],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('edits text+tagIds in place (rename + replace-mode tag write), id unchanged', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      renamePrompt: sinon.stub().resolves({ id: 'sem-1', name: 'next', is_updated: true }),
      updatePromptTagsByIds: sinon.stub().resolves(null),
      deletePromptsByIds: sinon.stub(),
      createPromptsByIds: sinon.stub(),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: ['tag-cat-1'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(200);
    // The response echoes the UNCHANGED id — the edit is in place, no re-create.
    expect(result.body).to.deep.equal({
      semrushPromptId: 'sem-1',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'next',
      tagIds: ['tag-cat-1'],
    });
    expect(transport.renamePrompt).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', 'sem-1', 'next');
    expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
      WORKSPACE,
      'proj-us-en',
      [{ id: 'sem-1', references: ['tag-cat-1'], replace: true }],
    );
    // Nothing is deleted or created anywhere on the edit path.
    expect(transport.deletePromptsByIds).to.have.callCount(0);
    expect(transport.createPromptsByIds).to.have.callCount(0);
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
  });

  it('drops falsy tagIds entries on PATCH before the tag write', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      renamePrompt: sinon.stub().resolves({ id: 'sem-1', name: 'next', is_updated: true }),
      updatePromptTagsByIds: sinon.stub().resolves(null),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: ['keep', '', undefined],
      },
      fakeLog(),
    );

    expect(result.body.tagIds).to.deep.equal(['keep']);
    expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
      WORKSPACE,
      'proj-us-en',
      [{ id: 'sem-1', references: ['keep'], replace: true }],
    );
  });

  it('drops malformed tagIds entries on PATCH like validateParentIdFormat does for parentId', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      renamePrompt: sinon.stub().resolves({ id: 'sem-1', name: 'next', is_updated: true }),
      updatePromptTagsByIds: sinon.stub().resolves(null),
      publishProject: sinon.stub().resolves(),
    };
    const tooLong = 'x'.repeat(201);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'next',
        tagIds: ['keep', 'has space', tooLong],
      },
      fakeLog(),
    );

    expect(result.body.tagIds).to.deep.equal(['keep']);
    expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
      WORKSPACE,
      'proj-us-en',
      [{ id: 'sem-1', references: ['keep'], replace: true }],
    );
  });

  it('400s when tagIds sanitizes to empty (every entry malformed)', async () => {
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      {},
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: ['has space', ''],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('400s when geoTargetId or languageCode missing from body', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      { text: 'next', tagIds: ['tag-1'] },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  it('404s when no market for the slice', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tagIds: ['tag-1'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(404);
    expect(result.body.error).to.equal('marketNotFound');
  });

  it('edits the prompt without paginating upstream prompts', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      // listPromptsByTags is not called from PATCH — wiring it as a
      // stub lets us assert callCount(0) so a regression that brings the
      // walk back fails this test.
      listPromptsByTags: sinon.stub(),
      renamePrompt: sinon.stub().resolves({ id: 'sem-1', name: 'new text', is_updated: true }),
      updatePromptTagsByIds: sinon.stub().resolves(null),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'new text', tagIds: ['tag-fresh'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(200);
    expect(result.body).to.deep.equal({
      semrushPromptId: 'sem-1',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'new text',
      tagIds: ['tag-fresh'],
    });
    expect(transport.listPromptsByTags).to.have.callCount(0);
    expect(transport.renamePrompt).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', 'sem-1', 'new text');
  });

  it('upstream rename 404 → return 404 promptNotFound (no tag write)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    // The prompt-gone 404 is gated by isUpstreamGone which requires
    // SerenityTransportError specifically. A generic Error with .status=404
    // must NOT trip the promptNotFound path.
    const err = new SerenityTransportError(404, 'not found');
    const transport = {
      renamePrompt: sinon.stub().rejects(err),
      updatePromptTagsByIds: sinon.stub(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-missing',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'x', tagIds: ['tag-1'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(404);
    expect(result.body.error).to.equal('promptNotFound');
    expect(transport.updatePromptTagsByIds).to.have.callCount(0);
  });

  // The collision contract (serenity-docs#63 decision 2): a rename onto a
  // sibling prompt's exact text is refused upstream with 409 and NOTHING has
  // mutated — the handler propagates it untouched so the controller's mapError
  // answers 409 `conflict`.
  it('upstream rename 409 (text collision) → throws with no tag write and no publish', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const err = new SerenityTransportError(409, 'conflict');
    const transport = {
      renamePrompt: sinon.stub().rejects(err),
      updatePromptTagsByIds: sinon.stub(),
      publishProject: sinon.stub(),
    };

    await expect(handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'a sibling\'s text', tagIds: ['tag-1'],
      },
      fakeLog(),
    )).to.be.rejectedWith(SerenityTransportError, /conflict/);
    expect(transport.updatePromptTagsByIds).to.have.callCount(0);
    expect(transport.publishProject).to.have.callCount(0);
  });

  it('rename non-404 error → throws (no tag write)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const err = Object.assign(new Error('upstream 503'), { status: 503 });
    const transport = {
      renamePrompt: sinon.stub().rejects(err),
      updatePromptTagsByIds: sinon.stub(),
    };

    await expect(handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'x', tagIds: ['tag-1'],
      },
      fakeLog(),
    )).to.be.rejectedWith(/upstream 503/);
    expect(transport.updatePromptTagsByIds).to.have.callCount(0);
  });

  // A tag-write failure after a successful rename is a half-applied edit (text
  // updated, tags not) — retryable, nothing lost. The error propagates and the
  // publish never fires, and the partial mutation is logged for on-call.
  it('throws when the tag write fails after a successful rename (no publish)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const tagErr = Object.assign(new Error('tag write boom'), { status: 500 });
    const transport = {
      renamePrompt: sinon.stub().resolves({ id: 'sem-1', name: 'x', is_updated: true }),
      updatePromptTagsByIds: sinon.stub().rejects(tagErr),
      publishProject: sinon.stub().resolves(),
    };

    const log = fakeLog();
    await expect(handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'x', tagIds: ['tag-1'],
      },
      log,
    )).to.be.rejectedWith(/tag write boom/);
    expect(transport.renamePrompt).to.have.been.calledOnce;
    expect(transport.publishProject).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnceWith(
      'updatePromptTagsByIds failed after a successful rename — text updated, tags stale',
      { semrushPromptId: 'sem-1', projectId: 'proj-us-en', error: 'tag write boom' },
    );
  });
});

describe('handlers/prompts.js — handleBulkDeletePrompts', () => {
  it('400s on empty prompts array', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, {
      prompts: [],
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Review minor #4: maxItems=500 cap on bulk-delete matches the OpenAPI
  // declaration. Defense-in-depth — within API Gateway's envelope, an
  // attacker could otherwise submit tens of thousands of items.
  it('400s when the prompts array exceeds maxItems=500', async () => {
    const dataAccess = makeDataAccess([]);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({
      semrushPromptId: `sem-${i}`,
      geoTargetId: 2840,
      languageCode: 'en',
    }));
    await expect(handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, {
      prompts: tooMany,
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode, /maxItems=500/);
  });

  // Branch coverage: body without `prompts` field → Array.isArray fallback to
  // [] then the empty-array 400 fires. Locks the contract that the handler
  // does not crash on a missing key.
  it('400s when body is null (no prompts field)', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, null, fakeLog()))
      .to.be.rejectedWith(ErrorWithStatusCode);
  });

  // Branch coverage: allByBrandId returns null → the `projects || []`
  // fallback runs in bulk-delete too; every target lands in `failed` because
  // no slice can be resolved.
  it('reports every target as failed when allByBrandId returns null', async () => {
    const dataAccess = makeDataAccess(null);
    const result = await handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' }],
    }, fakeLog());

    expect(result.deleted).to.equal(0);
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0].message).to.match(/No market for slice/);
  });

  // Branch coverage: an error without a `.status` field falls into the
  // `e.status || 500` branch → status defaults to 500.
  it('defaults failed.status to 500 when upstream error has no status property', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const err = new Error('opaque failure'); // no .status
    const transport = {
      deletePromptsByIds: sinon.stub().rejects(err),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' }],
    }, fakeLog());

    expect(result.failed[0].status).to.equal(500);
    expect(result.failed[0].message).to.equal('opaque failure');
  });

  it('reports failed rows for slices that do not exist on the brand', async () => {
    const dataAccess = makeDataAccess([]);
    const result = await handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ semrushPromptId: 'sem-1', geoTargetId: 9999, languageCode: 'xx' }],
    }, fakeLog());

    expect(result.deleted).to.equal(0);
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0].message).to.match(/No market for slice/);
  });

  it('treats upstream 404 as idempotent success', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    // SerenityTransportError(404) — isUpstreamGone strict-match.
    const err = new SerenityTransportError(404, 'not found');
    const transport = {
      deletePromptsByIds: sinon.stub().rejects(err),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' }],
    }, fakeLog());

    expect(result.deleted).to.equal(1);
    expect(result.failed).to.have.lengthOf(0);
    expect(transport.publishProject).to.have.been.calledOnce;
  });

  // Branch coverage: happy path — the success branch of the per-project
  // delete (no error thrown) bumps `deleted` and queues the project for
  // publish. Prior tests only hit the 404-idempotent and unknown-slice
  // paths, leaving this one uncovered.
  it('counts a successful bulk-delete and triggers publishProject once per project', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      deletePromptsByIds: sinon.stub().resolves(),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        { semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' },
        { semrushPromptId: 'sem-2', geoTargetId: 2840, languageCode: 'en' },
      ],
    }, fakeLog());

    expect(result.deleted).to.equal(2);
    expect(result.failed).to.have.lengthOf(0);
    // Single project = single publish, even though two prompts were deleted.
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
  });

  it('reports an entry in failed for each missing field in a bulk-delete target', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      deletePromptsByIds: sinon.stub(),
      publishProject: sinon.stub(),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        { /* missing semrushPromptId */ geoTargetId: 2840, languageCode: 'en' },
        { semrushPromptId: 'sem-2' /* missing geoTargetId + languageCode */ },
      ],
    }, fakeLog());

    expect(result.deleted).to.equal(0);
    expect(result.failed).to.have.lengthOf(2);
    expect(result.failed.every((f) => /Missing semrush/i.test(f.message))).to.equal(true);
    expect(transport.deletePromptsByIds).to.have.callCount(0);
  });

  // Branch coverage: non-404 upstream error in bulk-delete → each target in
  // the affected bucket lands in `failed` with the upstream status.
  it('reports per-target failure on non-404 upstream error', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const err = Object.assign(new Error('upstream 503'), { status: 503 });
    const transport = {
      deletePromptsByIds: sinon.stub().rejects(err),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        { semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' },
        { semrushPromptId: 'sem-2', geoTargetId: 2840, languageCode: 'en' },
      ],
    }, fakeLog());

    expect(result.deleted).to.equal(0);
    expect(result.failed).to.have.lengthOf(2);
    expect(result.failed.map((f) => f.semrushPromptId).sort()).to.deep.equal(['sem-1', 'sem-2']);
    expect(result.failed.every((f) => f.status === 503)).to.equal(true);
    expect(transport.publishProject).to.have.callCount(0);
  });

  // Branch coverage: bulk-delete succeeded upstream but publishProject fails
  // → a 502 entry with semrushPromptId: '' is appended (publish failure is
  // not tied to one prompt).
  it('appends a 502 failed entry when publishProject errors after a successful bulk-delete', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      deletePromptsByIds: sinon.stub().resolves(),
      publishProject: sinon.stub().rejects(new Error('publish boom')),
    };

    const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        { semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' },
      ],
    }, fakeLog());

    expect(result.deleted).to.equal(1);
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0]).to.deep.equal({
      semrushPromptId: '',
      status: 502,
      message: 'publish: publish boom',
    });
  });

  // Important #9 from review: bulk-delete buckets targets by project; per-bucket
  // upstream errors propagate into each target's `failed` entry. The
  // homogeneous cases (all 200, all 404, all 503) are covered above. The
  // bucketing logic itself — the only actually load-bearing thing in this
  // handler — needs mixed-mix coverage.
  describe('handleBulkDeletePrompts — mixed-mix scenarios (Important #9)', () => {
    it('(slice A 200 + slice B 503): A counts as deleted, B fans out per-target failed', async () => {
      const projectA = makeProject({
        semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
      });
      const projectB = makeProject({
        semrushProjectId: 'proj-de-de', geoTargetId: 2276, languageCode: 'de',
      });
      const dataAccess = makeDataAccess([projectA, projectB]);
      const transport = {
        deletePromptsByIds: sinon.stub(),
        publishProject: sinon.stub().resolves(),
      };
      transport.deletePromptsByIds.withArgs(WORKSPACE, 'proj-us-en').resolves();
      transport.deletePromptsByIds.withArgs(WORKSPACE, 'proj-de-de')
        .rejects(new SerenityTransportError(503, 'upstream wobble'));

      const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [
          { semrushPromptId: 'sem-A1', geoTargetId: 2840, languageCode: 'en' },
          { semrushPromptId: 'sem-A2', geoTargetId: 2840, languageCode: 'en' },
          { semrushPromptId: 'sem-B1', geoTargetId: 2276, languageCode: 'de' },
        ],
      }, fakeLog());

      // A bucket counted as deleted; B bucket fanned out across its targets.
      expect(result.deleted).to.equal(2);
      expect(result.failed).to.have.lengthOf(1);
      expect(result.failed[0]).to.include({
        semrushPromptId: 'sem-B1',
        geoTargetId: 2276,
        languageCode: 'de',
        status: 503,
      });
    });

    it('(slice A 200 + slice B 404 idempotent): both count as deleted, no failed entries', async () => {
      const projectA = makeProject({
        semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
      });
      const projectB = makeProject({
        semrushProjectId: 'proj-de-de', geoTargetId: 2276, languageCode: 'de',
      });
      const dataAccess = makeDataAccess([projectA, projectB]);
      const transport = {
        deletePromptsByIds: sinon.stub(),
        publishProject: sinon.stub().resolves(),
      };
      transport.deletePromptsByIds.withArgs(WORKSPACE, 'proj-us-en').resolves();
      transport.deletePromptsByIds.withArgs(WORKSPACE, 'proj-de-de')
        .rejects(new SerenityTransportError(404, 'gone'));

      const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [
          { semrushPromptId: 'sem-A1', geoTargetId: 2840, languageCode: 'en' },
          { semrushPromptId: 'sem-B1', geoTargetId: 2276, languageCode: 'de' },
        ],
      }, fakeLog());

      expect(result.deleted).to.equal(2);
      expect(result.failed).to.have.lengthOf(0);
      // Both buckets queued for publish (404-as-success still rolls up).
      expect(transport.publishProject).to.have.callCount(2);
    });

    it('(valid + invalid item shapes in same body): valid items succeed, invalid items land in failed', async () => {
      const project = makeProject({
        semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
      });
      const dataAccess = makeDataAccess([project]);
      const transport = {
        deletePromptsByIds: sinon.stub().resolves(),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [
          { semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' },
          // missing semrushPromptId
          { geoTargetId: 2840, languageCode: 'en' },
          // unparseable geoTargetId
          { semrushPromptId: 'sem-2', geoTargetId: 'abc', languageCode: 'en' },
          // unsupported languageCode shape
          { semrushPromptId: 'sem-3', geoTargetId: 2840, languageCode: 'ENG-X' },
        ],
      }, fakeLog());

      expect(result.deleted).to.equal(1);
      // Tight bound (matches the contract: each invalid input → exactly one
      // failed entry). A regression that double-pushed a target into `failed`
      // would still satisfy `at.least(3)` — `lengthOf(3)` catches it.
      expect(result.failed).to.have.lengthOf(3);
      expect(transport.deletePromptsByIds).to.have.callCount(1);
    });
  });
});

// Important #6 from review: tag-cache invalidation contract must hold across
// every mutating handler. Without these tests, dropping `invalidateTagCacheForProject`
// from any of POST /prompts, PATCH /prompts/:id, DELETE /prompts (bulk) would
// not trip either suite — and stale tags become user-visible at the 60s TTL
// boundary.
describe('handlers/prompts.js — tag cache invalidation (Important #6)', () => {
  // Late dynamic imports: invalidateTagCacheForProject lives in markets.js,
  // and module-scoped state across the two handlers is the actual contract
  // these tests lock.
  async function setupCachedTagsAndMutationTransport(initialTags, mutatedTags) {
    const { handleListTags, clearTagCache } = await import('../../../../src/support/serenity/handlers/markets.js');
    clearTagCache();

    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    // Build the stub explicitly so onFirstCall / onSecondCall configure the
    // SAME stub object (the fluent `sinon.stub().onFirstCall().resolves(...)`
    // form binds the StubBehavior to `transport.listPromptsByTags`, not the
    // stub itself — that subtle pitfall causes the cache test to read the
    // wrong page on second call).
    const listPromptsByTags = sinon.stub();
    listPromptsByTags.onFirstCall().resolves({
      items: initialTags.map((t, i) => ({ id: `p${i}`, name: `q${i}`, tags: [t] })),
    });
    listPromptsByTags.onSecondCall().resolves({
      items: mutatedTags.map((t, i) => ({ id: `m${i}`, name: `q${i}`, tags: [t] })),
    });

    // Step 1: populate cache via handleListTags with set A.
    const transport = { listPromptsByTags };
    await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    return {
      handleListTags, transport, dataAccess, project,
    };
  }

  it('POST /prompts invalidates the cached tag set (next listTags re-walks upstream)', async () => {
    const setupCtx = await setupCachedTagsAndMutationTransport(['old-tag'], ['new-tag']);
    const {
      handleListTags, transport, dataAccess,
    } = setupCtx;

    // Mutation: handleCreatePrompts pushes a new prompt → invalidate.
    transport.createPromptsByIds = sinon.stub().resolves({
      page: 1, total: 1, items: [{ id: 'sem-new', name: 'fresh' }],
    });
    transport.publishProject = sinon.stub().resolves();
    await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'fresh',
        tagIds: ['tag-new'],
        geoTargetId: 2840,
        languageCode: 'en',
      }],
    }, fakeLog());

    // Verify cache miss: handleListTags now returns set B.
    const refetched = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(refetched.items.map((t) => t.name)).to.deep.equal(['new-tag']);
    // Two upstream walks: the initial cache populate + the post-invalidation re-fetch.
    expect(transport.listPromptsByTags).to.have.callCount(2);
  });

  it('PATCH /prompts/:id invalidates the cached tag set', async () => {
    const setupCtx = await setupCachedTagsAndMutationTransport(['old-tag'], ['new-tag']);
    const {
      handleListTags, transport, dataAccess,
    } = setupCtx;

    transport.renamePrompt = sinon.stub().resolves({ id: 'sem-1', name: 'updated', is_updated: true });
    transport.updatePromptTagsByIds = sinon.stub().resolves(null);
    transport.publishProject = sinon.stub().resolves();
    await handleUpdatePrompt(transport, dataAccess, BRAND, WORKSPACE, 'sem-1', {
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'updated',
      tagIds: ['tag-new'],
    }, fakeLog());

    const refetched = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(refetched.items.map((t) => t.name)).to.deep.equal(['new-tag']);
    expect(transport.listPromptsByTags).to.have.callCount(2);
  });

  it('bulk-delete /prompts invalidates the cached tag set', async () => {
    const setupCtx = await setupCachedTagsAndMutationTransport(['old-tag'], ['kept-tag']);
    const {
      handleListTags, transport, dataAccess,
    } = setupCtx;

    transport.deletePromptsByIds = sinon.stub().resolves();
    transport.publishProject = sinon.stub().resolves();
    await handleBulkDeletePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        { semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' },
      ],
    }, fakeLog());

    const refetched = await handleListTags(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    }, fakeLog());

    expect(refetched.items.map((t) => t.name)).to.deep.equal(['kept-tag']);
    expect(transport.listPromptsByTags).to.have.callCount(2);
  });
});

describe('handlers/prompts.js — defensive branch coverage', () => {
  // Line 152: `Number.isFinite(resp?.total)?resp.total:items.length` else branch —
  // fires when a full page is returned (items.length >= limit) but resp.total is
  // missing or non-finite. The else falls back to items.length as the best available
  // count estimate.
  it('handleListPrompts: falls back to items.length when total is missing on a full upstream page', async () => {
    const project = {
      getSemrushProjectId: () => 'proj-us-en',
      getGeoTargetId: () => 2840,
      getLanguageCode: () => 'en',
    };
    const dataAccess = {
      BrandSemrushProject: {
        allByBrandId: () => Promise.resolve([project]),
        findBySlice: () => Promise.resolve(project),
      },
    };
    // Return exactly `limit` items (10) with no `total` field — items.length (10)
    // is NOT < limit (10) so the else branch fires; Number.isFinite(undefined)
    // is false so total = items.length = 10.
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ id: `s-${i}`, name: `prompt ${i}` }));
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: () => Promise.resolve({ items: fullPage /* no total */ }),
    };
    const { handleListPrompts: hlp } = await import(
      '../../../../src/support/serenity/handlers/prompts.js'
    );
    const brandId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const workspaceId = 'workspace-1';
    const result = await hlp(transport, dataAccess, brandId, workspaceId, {
      geoTargetId: 2840, languageCode: 'en', limit: 10,
    });
    // items.length (10) >= limit (10) → else branch; total is undefined → items.length.
    expect(result.total).to.equal(10);
  });
});

describe('handlers/prompts.js — unified type classification (serenity-docs#31)', () => {
  const project = () => makeProject({
    semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
  });

  describe('id-based create', () => {
    it('resolves the computed type to a tag id and strips a caller-supplied type id', async () => {
      const dataAccess = makeDataAccess([project()]);
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'is Acme good?' }],
        }),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [{
          text: 'is Acme good?',
          geoTargetId: 2840,
          languageCode: 'en',
          // The caller supplies `non-branded`; the server computes `branded`.
          tagIds: [TAG_IDS.categoryRunningShoes, TAG_IDS.typeNonBranded],
        }],
      }, fakeLog(), classifyByBrandMention);

      expect(result.created[0].tagIds).to.deep.equal([
        TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded,
      ]);
      expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-us-en',
        ['is Acme good?'],
        [TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded],
      );
      // The whole taxonomy already exists, so nothing is provisioned.
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('classifies non-branded when the brand is not mentioned', async () => {
      const dataAccess = makeDataAccess([project()]);
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'best running shoes' }],
        }),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [{
          text: 'best running shoes',
          geoTargetId: 2840,
          languageCode: 'en',
          tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      }, fakeLog(), classifyByBrandMention);

      expect(result.created[0].tagIds).to.deep.equal([
        TAG_IDS.categoryRunningShoes, TAG_IDS.typeNonBranded,
      ]);
    });

    // Strip-by-root, not strip-by-name: a customer category may legitimately be
    // named `branded` without being the `type` value. Only ids beneath the
    // `type` root are the server's to overwrite.
    it('leaves a same-named category tag alone while stripping the real type value', async () => {
      const dataAccess = makeDataAccess([project()]);
      const decoyCategoryId = 'category-branded-decoy';
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.categoryRoot] = [
        ...levels[TAG_IDS.categoryRoot],
        {
          id: decoyCategoryId,
          name: 'branded',
          parent_id: TAG_IDS.categoryRoot,
          children_count: 0,
          path: [{ id: TAG_IDS.categoryRoot, name: 'category' }],
        },
      ];
      const transport = {
        listProjectTags: makeListProjectTagsStub(levels),
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'is Acme good?' }],
        }),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [{
          text: 'is Acme good?',
          geoTargetId: 2840,
          languageCode: 'en',
          tagIds: [decoyCategoryId, TAG_IDS.typeNonBranded],
        }],
      }, fakeLog(), classifyByBrandMention);

      expect(result.created[0].tagIds).to.deep.equal([decoyCategoryId, TAG_IDS.typeBranded]);
    });

    // Projects that predate the taxonomy carry none of it; the first write
    // brings them forward rather than 500ing on an unresolvable tag id.
    it('provisions the type root and value on a project that has neither', async () => {
      const dataAccess = makeDataAccess([project()]);
      const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
      const transport = {
        listProjectTags,
        createProjectTags,
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-sem-id', name: 'is Acme good?' }],
        }),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
        prompts: [{
          text: 'is Acme good?', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-cat-1'],
        }],
      }, fakeLog(), classifyByBrandMention);

      // The four roots are created at the root level, then `branded` beneath
      // the freshly-minted `type` root.
      expect(createProjectTags.firstCall.args[2]).to.deep.equal([
        'category', 'intent', 'origin', 'type',
      ]);
      expect(createProjectTags.firstCall.args[3]).to.deep.equal({});
      expect(createProjectTags.secondCall.args[2]).to.deep.equal(['branded']);
      expect(createProjectTags.secondCall.args[3]).to.deep.equal({ parentId: 'created::type' });
      expect(result.created[0].tagIds).to.deep.equal(['tag-cat-1', 'created:created::type:branded']);
    });
  });

  describe('update recomputes from the new text', () => {
    it('recomputes the type tag on edit', async () => {
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(project());
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        renamePrompt: sinon.stub().resolves({ id: 'old-id', name: 'now mentions Acme', is_updated: true }),
        updatePromptTagsByIds: sinon.stub().resolves(null),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleUpdatePrompt(transport, dataAccess, BRAND, WORKSPACE, 'old-id', {
        text: 'now mentions Acme',
        geoTargetId: 2840,
        languageCode: 'en',
        tagIds: [TAG_IDS.categoryRunningShoes],
      }, fakeLog(), classifyByBrandMention);

      expect(result.status).to.equal(200);
      expect(result.body.tagIds).to.deep.equal([
        TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded,
      ]);
      // The injector's output is the full replacement set the tag write sends.
      expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-us-en',
        [{
          id: 'old-id',
          references: [TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded],
          replace: true,
        }],
      );
    });

    // The tree read (and any provisioning it triggers) must happen BEFORE any
    // upstream write, so a classification failure leaves the prompt intact.
    it('resolves the type BEFORE writing to the prompt', async () => {
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(project());
      const transport = {
        listProjectTags: sinon.stub().rejects(new Error('tag tree unavailable')),
        renamePrompt: sinon.stub().resolves(),
        updatePromptTagsByIds: sinon.stub(),
        publishProject: sinon.stub().resolves(),
      };

      await expect(handleUpdatePrompt(transport, dataAccess, BRAND, WORKSPACE, 'old-id', {
        text: 'now mentions Acme',
        geoTargetId: 2840,
        languageCode: 'en',
        tagIds: [TAG_IDS.categoryRunningShoes],
      }, fakeLog(), classifyByBrandMention)).to.be.rejectedWith(/tag tree unavailable/);

      expect(transport.renamePrompt).to.not.have.been.called;
      expect(transport.updatePromptTagsByIds).to.not.have.been.called;
    });
  });

  describe('makeTypeInjector cache (serenity-docs#31)', () => {
    it('resolves each (project, type) once across a batch, re-resolving only on a new key', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const inject = makeTypeInjector(transport, WORKSPACE, classifyByBrandMention, fakeLog());

      // Resolving one (project, type) key reads two levels: the roots, then the
      // children of the `type` root.
      const a = await inject('proj-1', { text: 'love Acme', geoTargetId: 2840, tagIds: ['x'] });
      expect(transport.listProjectTags).to.have.callCount(2);

      // Same project + same computed type => served from cache, no new reads.
      const b = await inject('proj-1', { text: 'Acme rocks', geoTargetId: 2840, tagIds: ['y'] });
      expect(transport.listProjectTags).to.have.callCount(2);
      expect(a.tagIds).to.deep.equal(['x', TAG_IDS.typeBranded]);
      expect(b.tagIds).to.deep.equal(['y', TAG_IDS.typeBranded]);

      // A different computed type is a new cache key => one more resolution.
      const c = await inject('proj-1', { text: 'best running shoes', geoTargetId: 2840, tagIds: ['z'] });
      expect(transport.listProjectTags).to.have.callCount(4);
      expect(c.tagIds).to.deep.equal(['z', TAG_IDS.typeNonBranded]);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('passes the input through untouched when no classifier is supplied', async () => {
      const transport = { listProjectTags: sinon.stub(), createProjectTags: sinon.stub() };
      const inject = makeTypeInjector(transport, WORKSPACE, undefined, fakeLog());

      const out = await inject('proj-1', { text: 'anything', geoTargetId: 2840, tagIds: ['x'] });

      expect(out.tagIds).to.deep.equal(['x']);
      expect(transport.listProjectTags).to.not.have.been.called;
    });
  });
});
