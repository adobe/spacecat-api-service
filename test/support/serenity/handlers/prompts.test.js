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
} from '../../../../src/support/serenity/handlers/prompts.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

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

  it('returns empty page when no market exists for the slice', async () => {
    const transport = { listPromptsByTags: sinon.stub() };
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(null);

    const result = await handleListPrompts(transport, dataAccess, BRAND, WORKSPACE, {
      geoTargetId: 2840, languageCode: 'en',
    });

    expect(result).to.deep.equal({
      items: [], total: 0, page: 1, limit: 50,
    });
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

  // Branch coverage: `t || ''` falsy short-circuit in input normalization
  // and PATCH tag scrubbing — a tag entry that is the empty string is
  // dropped by the trim+filter pipeline.
  it('drops empty / falsy tag entries from create and update inputs', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-id'] }),
      publishProject: sinon.stub().resolves(),
      deletePromptsByIds: sinon.stub().resolves(),
    };

    // CREATE — tags array with a falsy entry → dropped silently.
    const createResult = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hi', geoTargetId: 2840, languageCode: 'en', tags: ['keep', '', null],
      }],
    }, fakeLog());
    expect(createResult.created[0].tags).to.deep.equal(['keep']);

    // PATCH — tags array with a falsy entry → dropped silently.
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const updateResult = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'next', tags: ['keep', undefined],
      },
      fakeLog(),
    );
    expect(updateResult.body.tags).to.deep.equal(['keep']);
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
    expect(result.items[0].tags).to.deep.equal(['consideration']);
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
    });
  });

  it('maps upstream items to SerenityPrompt DTOs without leaking semrushProjectId or synthetic ids', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);
    const transport = {
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
      tags: ['awareness'],
    });
    expect(result.items[0]).not.to.have.property('id');
    expect(result.items[0]).not.to.have.property('semrushProjectId');
  });
});

describe('handlers/prompts.js — handleCreatePrompts', () => {
  it('400s on empty prompts array (no upstream call)', async () => {
    const transport = { createTaggedPrompts: sinon.stub() };
    const dataAccess = makeDataAccess([]);

    await expect(handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [],
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode);
    expect(transport.createTaggedPrompts).not.to.have.been.called;
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
    const transport = { createTaggedPrompts: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'orphaned', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(transport.createTaggedPrompts).to.have.callCount(0);
  });

  // Branch coverage: raw input with no `text` field → normalizePromptInput
  // returns null and the row lands in `skipped` with `text: ''`.
  it('skips inputs with no text field (raw.text undefined → empty string)', async () => {
    const dataAccess = makeDataAccess([]);
    const transport = { createTaggedPrompts: sinon.stub() };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ geoTargetId: 2840, languageCode: 'en', tags: [] }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].text).to.equal('');
  });

  // Branch coverage: createTaggedPrompts rejects with an error that has no
  // `.status` field → `e.status || 500` defaults to 500.
  it('defaults failed.status to 500 when upstream error has no status property', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createTaggedPrompts: sinon.stub().rejects(new Error('opaque failure')),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'will fail', geoTargetId: 2840, languageCode: 'en', tags: [],
      }],
    }, fakeLog());

    expect(result.failed[0].status).to.equal(500);
  });

  it('skips inputs missing required fields', async () => {
    const transport = { createTaggedPrompts: sinon.stub() };
    const dataAccess = makeDataAccess([]);

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{ text: 'no slice' }],
    }, fakeLog());

    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].text).to.equal('no slice');
  });

  it('creates a prompt and emits a SerenityPrompt DTO without semrushProjectId', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const transport = {
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-sem-id'] }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'hello', geoTargetId: 2840, languageCode: 'en', tags: ['a'],
      }],
    }, fakeLog());

    expect(result.created).to.have.lengthOf(1);
    expect(result.created[0]).to.deep.equal({
      semrushPromptId: 'new-sem-id',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'hello',
      tags: ['a'],
    });
    expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en');
  });

  it('skips inputs whose (geoTargetId, languageCode) slice has no row on the brand', async () => {
    const usEn = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([usEn]);
    const transport = {
      createTaggedPrompts: sinon.stub(),
      publishProject: sinon.stub(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [
        {
          text: 'good', geoTargetId: 2840, languageCode: 'en', tags: [],
        },
        {
          text: 'orphan', geoTargetId: 9999, languageCode: 'xx', tags: [],
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
    expect(transport.createTaggedPrompts).to.have.callCount(1);
  });

  // Branch coverage: upstream createTaggedPrompts rejects → that row enters the
  // `failed` bucket with the upstream error's status code, but the rest of the
  // batch continues.
  it('reports per-input failures when upstream createTaggedPrompts rejects', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([project]);
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const transport = {
      createTaggedPrompts: sinon.stub().rejects(err),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'will fail', geoTargetId: 2840, languageCode: 'en', tags: [],
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
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-sem-id'] }),
      publishProject: sinon.stub().rejects(new Error('publish boom')),
    };

    const result = await handleCreatePrompts(transport, dataAccess, BRAND, WORKSPACE, {
      prompts: [{
        text: 'ok', geoTargetId: 2840, languageCode: 'en', tags: [],
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
  // body as the full next state, so omitting either text or tags is a
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
      { geoTargetId: 2840, languageCode: 'en', tags: ['only-tags'] },
      fakeLog(),
    );

    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('missingFields');
  });

  it('400s when tags is missing from body', async () => {
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

  it('400s when geoTargetId or languageCode missing from body', async () => {
    const transport = {};
    const dataAccess = makeDataAccess([]);

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      { text: 'next', tags: [] },
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
        geoTargetId: 2840, languageCode: 'en', text: 'next', tags: [],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(404);
    expect(result.body.error).to.equal('marketNotFound');
  });

  it('replaces text+tags and never paginates upstream prompts', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      // listPromptsByTags is no longer called from PATCH — wiring it as a
      // stub lets us assert callCount(0) so a regression that brings the
      // walk back fails this test.
      listPromptsByTags: sinon.stub(),
      deletePromptsByIds: sinon.stub().resolves(),
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-sem-id'] }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'new text', tags: ['fresh'],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(200);
    expect(result.body).to.deep.equal({
      semrushPromptId: 'new-sem-id',
      geoTargetId: 2840,
      languageCode: 'en',
      text: 'new text',
      tags: ['fresh'],
    });
    expect(transport.listPromptsByTags).to.have.callCount(0);
    expect(transport.deletePromptsByIds).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-us-en', ['sem-1']);
  });

  it('upstream DELETE 404 → return 404 (no create)', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const err = Object.assign(new Error('not found'), { status: 404 });
    const transport = {
      deletePromptsByIds: sinon.stub().rejects(err),
      createTaggedPrompts: sinon.stub(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-missing',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'x', tags: [],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(404);
    expect(result.body.error).to.equal('promptNotFound');
    expect(transport.createTaggedPrompts).to.have.callCount(0);
  });

  // Branch coverage: body.tags is defined but not an array → handler treats
  // it as "no tags" rather than throwing or 400ing. The 400 path only catches
  // body.tags === undefined; once defined, the Array.isArray guard runs.
  it('coerces non-array tags to empty list', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      deletePromptsByIds: sinon.stub().resolves(),
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-sem-id'] }),
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 't', tags: null,
      },
      fakeLog(),
    );

    expect(result.status).to.equal(200);
    expect(result.body.tags).to.deep.equal([]);
  });

  // Branch coverage: upstream createTaggedPrompts returns no ids array →
  // semrushPromptId becomes empty string (and downstream can detect the
  // anomaly without us silently throwing).
  it('returns empty semrushPromptId when upstream createTaggedPrompts has no ids', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const transport = {
      deletePromptsByIds: sinon.stub().resolves(),
      createTaggedPrompts: sinon.stub().resolves({}), // no ids
      publishProject: sinon.stub().resolves(),
    };

    const result = await handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 't', tags: [],
      },
      fakeLog(),
    );

    expect(result.status).to.equal(200);
    expect(result.body.semrushPromptId).to.equal('');
  });

  it('DELETE non-404 error → throws (no CREATE) to prevent duplicate', async () => {
    const project = makeProject({
      semrushProjectId: 'proj-us-en', geoTargetId: 2840, languageCode: 'en',
    });
    const dataAccess = makeDataAccess([]);
    dataAccess.BrandSemrushProject.findBySlice.resolves(project);

    const err = Object.assign(new Error('upstream 503'), { status: 503 });
    const transport = {
      deletePromptsByIds: sinon.stub().rejects(err),
      createTaggedPrompts: sinon.stub().resolves({ ids: ['should-not-happen'] }),
    };

    // The previous warn-and-create behavior would leave both old and new
    // prompts in the project; this assertion locks the new throw-on-error
    // contract so a regression resurrects #1.
    await expect(handleUpdatePrompt(
      transport,
      dataAccess,
      BRAND,
      WORKSPACE,
      'sem-1',
      {
        geoTargetId: 2840, languageCode: 'en', text: 'x', tags: [],
      },
      fakeLog(),
    )).to.be.rejectedWith(/upstream 503/);
    expect(transport.createTaggedPrompts).to.have.callCount(0);
  });
});

describe('handlers/prompts.js — handleBulkDeletePrompts', () => {
  it('400s on empty prompts array', async () => {
    const dataAccess = makeDataAccess([]);
    await expect(handleBulkDeletePrompts({}, dataAccess, BRAND, WORKSPACE, {
      prompts: [],
    }, fakeLog())).to.be.rejectedWith(ErrorWithStatusCode);
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
    const err = Object.assign(new Error('not found'), { status: 404 });
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
});
