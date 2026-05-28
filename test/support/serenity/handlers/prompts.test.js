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
});
