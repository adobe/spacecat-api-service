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
  createProvisionAndPublishProject,
  CreateNoProjectIdError,
  primaryUrlPatchBody,
} from '../../../src/support/serenity/project-provisioning.js';

const WS = 'workspace-1';
const CREATE_BODY = { name: 'US-en', type: 'ai', domain: 'nba.com' };

describe('serenity project-provisioning: createProvisionAndPublishProject', () => {
  let transport;
  let log;

  beforeEach(() => {
    transport = {
      createProject: sinon.stub().resolves({ id: 'proj-1' }),
      updateProject: sinon.stub().resolves(),
      publishProject: sinon.stub().resolves(),
      deleteProject: sinon.stub().resolves(),
    };
    log = { error: sinon.spy(), warn: sinon.spy(), info: sinon.spy() };
  });

  afterEach(() => sinon.restore());

  it('creates, PATCHes the tracked url, then publishes — in that order', async () => {
    const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    });

    expect(id).to.equal('proj-1');
    expect(transport.createProject).to.have.been.calledOnceWith(WS, CREATE_BODY);
    expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    // The order is forced by the upstream: create ignores primary_url, and a PATCH
    // after the publish would leave the corrected value sitting in draft.
    expect(transport.createProject).to.have.been.calledBefore(transport.updateProject);
    expect(transport.updateProject).to.have.been.calledBefore(transport.publishProject);
  });

  it('sends primary_url FLAT with the required type, not nested under settings.ai', async () => {
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    });

    // `model.ProjectUpdateRequest` declares primary_url at the top level and has no
    // `settings` member at all; the nested spelling is accepted and IGNORED, which
    // would look like success while changing nothing.
    expect(transport.updateProject.firstCall.args[2]).to.deep.equal({
      type: 'ai',
      primary_url: 'nba.com/kings',
    });
  });

  it('skips the PATCH when there is no tracked url to set', async () => {
    // Skipped rather than sent empty: blanking the field would replace the
    // upstream's own apex default with nothing.
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log });

    expect(transport.updateProject).to.not.have.been.called;
    expect(transport.publishProject).to.have.been.calledOnce;
  });

  it('skips the PATCH for a blank tracked url', async () => {
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: '   ', log,
    });

    expect(transport.updateProject).to.not.have.been.called;
  });

  it('throws when create returns no id, and touches nothing else', async () => {
    transport.createProject.resolves({});

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log }))
      .to.be.rejectedWith('Upstream createProject returned no id');
    expect(transport.updateProject).to.not.have.been.called;
    expect(transport.publishProject).to.not.have.been.called;
    expect(transport.deleteProject).to.not.have.been.called;
  });

  it('throws CreateNoProjectIdError specifically, so the 502 mapping cannot be reworded away', async () => {
    // The handler translates this into a 502 `createNoProjectId` that callers use to
    // decide whether a retry is safe. Asserting the type — not the wording — is what
    // keeps a message edit from silently downgrading that 502 to an unhandled 500.
    transport.createProject.resolves({});

    const err = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log })
      .then(() => null, (e) => e);
    expect(err).to.be.instanceOf(CreateNoProjectIdError);
  });

  it('builds the PATCH body through primaryUrlPatchBody, so `type` is always present', () => {
    // `type` is required on every project PATCH whatever field is being set, and
    // omitting it is rejected upstream.
    expect(primaryUrlPatchBody('nba.com/kings'))
      .to.deep.equal({ type: 'ai', primary_url: 'nba.com/kings' });
  });

  it('a failed PATCH deletes the orphan, never publishes, and rethrows', async () => {
    // A created-but-unpublished draft is the same artefact a failed publish leaves,
    // so it gets the same cleanup. Publishing anyway would record a project as
    // provisioned while it tracks the wrong url — the defect this change removes.
    transport.updateProject.rejects(new Error('upstream 503'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log, caller: 'handleCreateMarket',
    })).to.be.rejectedWith('upstream 503');

    expect(transport.publishProject).to.not.have.been.called;
    expect(transport.deleteProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: provisioning failed; upstream project cleaned up',
    );
  });

  it('a failed publish deletes the orphan and rethrows', async () => {
    transport.publishProject.rejects(new Error('upstream 503'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    })).to.be.rejectedWith('upstream 503');

    expect(transport.deleteProject).to.have.been.calledOnceWith(WS, 'proj-1');
  });

  it('a failed cleanup is logged but never masks the original error', async () => {
    transport.publishProject.rejects(new Error('upstream 503'));
    transport.deleteProject.rejects(new Error('cleanup glitch'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log, caller: 'handleCreateMarket',
    })).to.be.rejectedWith('upstream 503');

    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: best-effort cleanup deleteProject failed; orphan upstream project remains',
    );
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: orphaned upstream project after provisioning failure',
    );
  });

  it('carries the caller log context into the failure logs', async () => {
    transport.publishProject.rejects(new Error('boom'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings',
      log,
      logContext: { brandId: 'brand-1', languageCode: 'en' },
    })).to.be.rejectedWith('boom');

    expect(log.error).to.have.been.calledWithMatch(
      sinon.match.string,
      sinon.match({ brandId: 'brand-1', languageCode: 'en', semrushProjectId: 'proj-1' }),
    );
  });

  it('tolerates a caller with no logger', async () => {
    transport.publishProject.rejects(new Error('boom'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings',
    })).to.be.rejectedWith('boom');
    expect(transport.deleteProject).to.have.been.calledOnce;
  });

  it('defaults its options entirely', async () => {
    const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY);

    expect(id).to.equal('proj-1');
    expect(transport.updateProject).to.not.have.been.called;
  });
});
