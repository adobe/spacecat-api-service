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
import esmock from 'esmock';

import {
  marketProjectName,
  MAX_TOPICS_ON_CREATE,
  STANDARD_PROMPT_TAGS,
  PROJECT_STANDARD_TAGS,
} from '../../../src/support/serenity/brand-provisioning.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

const PARENT_WS = 'parent-ws-1111';
const NEW_WS = 'sub-ws-2222';

function buildContext() {
  return {
    env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
    pathInfo: { headers: { authorization: 'Bearer test-ims-token' } },
  };
}

async function loadModule({ resolveWorkspaceId, handleCreateMarketSubworkspace }) {
  return esmock('../../../src/support/serenity/brand-provisioning.js', {
    '../../../src/support/serenity/workspace-resolver.js': { resolveWorkspaceId },
    '../../../src/support/serenity/rest-transport.js': {
      createSerenityTransport: () => ({}),
      SerenityTransportError,
    },
    '../../../src/support/serenity/handlers/markets-subworkspace.js': { handleCreateMarketSubworkspace },
  });
}

const baseParams = {
  spaceCatId: 'org-1',
  brandId: 'brand-1',
  brandName: 'Acme',
  market: 'us',
  languageCode: 'en',
  brandDomain: 'acme.com',
  modelIds: ['m-1', 'm-2'],
};

describe('marketProjectName', () => {
  it('formats "REGION - LANG" upper-cased', () => {
    expect(marketProjectName('us', 'en')).to.equal('US - EN');
    expect(marketProjectName('ch', 'de')).to.equal('CH - DE');
  });

  it('uses only the primary language subtag', () => {
    expect(marketProjectName('us', 'en-US')).to.equal('US - EN');
  });
});

describe('provisionBrandSubworkspace', () => {
  let resolveWorkspaceId;
  let handleCreateMarketSubworkspace;

  beforeEach(() => {
    resolveWorkspaceId = sinon.stub().resolves(PARENT_WS);
    // Mimic the real handler: ensureSubworkspace would set the brand stub's
    // workspace id, then a project is created. Stub captures that side-effect.
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushWorkspaceId(NEW_WS);
      return { status: 201, body: { brandId: brand.getId() } };
    });
  });

  it('provisions the sub-workspace and returns its id', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result).to.deep.equal({ semrushWorkspaceId: NEW_WS, published: false });
  });

  it('passes the "REGION - LANG" project name and brand identity to the handler', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    await provisionBrandSubworkspace(buildContext(), baseParams);
    const { args } = handleCreateMarketSubworkspace.firstCall;
    const [, brandStub, parentWs, body, , , , options] = args;
    expect(parentWs).to.equal(PARENT_WS);
    expect(body.name).to.equal('US - EN');
    expect(body.market).to.equal('us');
    expect(body.languageCode).to.equal('en');
    expect(body.brandDomain).to.equal('acme.com');
    expect(body.brandNames).to.deep.equal(['Acme']);
    // Brand-create attaches LLMs, generates+attaches topic-tagged prompts, then
    // publishes best-effort.
    expect(options).to.deep.equal({
      modelIds: ['m-1', 'm-2'],
      generateTopics: true,
      topicCap: MAX_TOPICS_ON_CREATE,
      standardTags: STANDARD_PROMPT_TAGS,
      brandAliases: [],
      projectTags: PROJECT_STANDARD_TAGS,
      publishMode: 'require',
    });
    // The stub drives the sub-workspace title off the brand's name + id.
    expect(brandStub.getName()).to.equal('Acme');
    expect(brandStub.getId()).to.equal('brand-1');
    expect(brandStub.getSemrushWorkspaceId()).to.equal(undefined);
  });

  it('forwards brandAliases to the handler for branded prompt classification', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    await provisionBrandSubworkspace(buildContext(), {
      ...baseParams, brandAliases: ['Acme Inc', 'ACME Corp'],
    });
    const [, , , , , , , options] = handleCreateMarketSubworkspace.firstCall.args;
    expect(options.brandAliases).to.deep.equal(['Acme Inc', 'ACME Corp']);
  });

  it('throws 400 when the organization has no parent workspace', async () => {
    resolveWorkspaceId.resolves(null);
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(400);
      expect(handleCreateMarketSubworkspace.called).to.equal(false);
    }
  });

  it('maps a handler 4xx into a thrown error of the same status', async () => {
    handleCreateMarketSubworkspace.resolves({ status: 409, body: { message: 'slice exists' } });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(409);
      expect(e.message).to.equal('slice exists');
    }
  });

  it('maps an upstream 405 (disguised quota) to a 409 "Quota exceeded"', async () => {
    handleCreateMarketSubworkspace.rejects(new SerenityTransportError(405, 'Semrush POST .../tagged failed: 405'));
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(409);
      expect(e.message).to.equal('Quota exceeded');
    }
  });

  it('re-throws a non-405 upstream transport error unchanged', async () => {
    handleCreateMarketSubworkspace.rejects(new SerenityTransportError(500, 'boom'));
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.equal('boom');
      expect(e.status).to.equal(500);
    }
  });

  it('throws 502 when the handler succeeds but no workspace id was captured', async () => {
    handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(502);
    }
  });

  it('throws 400 on missing required params before any upstream call', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    for (const bad of [
      { ...baseParams, brandName: '' },
      { ...baseParams, brandId: '' },
      { ...baseParams, market: '' },
      { ...baseParams, languageCode: '' },
      { ...baseParams, brandDomain: '' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      try {
        // eslint-disable-next-line no-await-in-loop
        await provisionBrandSubworkspace(buildContext(), bad);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.status).to.equal(400);
      }
    }
    expect(resolveWorkspaceId.called).to.equal(false);
  });
});
