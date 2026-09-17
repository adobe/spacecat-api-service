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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { reparentSiteProjectToOrg } from '../../../../src/controllers/plg/plg-onboarding/site-setup.js';

use(sinonChai);

const TARGET_ORG = 'customer-org';
const SOURCE_ORG = 'internal-demo-org';

describe('reparentSiteProjectToOrg', () => {
  let sandbox;
  let log;
  let Project;
  let Site;
  let context;

  const makeSite = (overrides = {}) => ({
    getId: sandbox.stub().returns(overrides.id || 'site-1'),
    getBaseURL: sandbox.stub().returns(overrides.baseURL || 'https://example.com'),
    getProjectId: sandbox.stub().returns(overrides.projectId ?? null),
    setProjectId: sandbox.stub(),
  });

  const makeProject = (orgId) => ({
    getId: sandbox.stub().returns('project-1'),
    getProjectName: sandbox.stub().returns('example.com'),
    getOrganizationId: sandbox.stub().returns(orgId),
    setOrganizationId: sandbox.stub(),
    save: sandbox.stub().resolves(),
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
    Project = {
      findById: sandbox.stub(),
      allByOrganizationId: sandbox.stub().resolves([]),
      create: sandbox.stub(),
    };
    Site = { allByProjectId: sandbox.stub() };
    context = { dataAccess: { Project, Site }, log };
  });

  afterEach(() => sandbox.restore());

  it('does nothing and returns false when the site has no project', async () => {
    const site = makeSite({ projectId: null });
    const mutated = await reparentSiteProjectToOrg(site, TARGET_ORG, context);
    expect(mutated).to.be.false;
    expect(Project.findById).to.not.have.been.called;
    expect(site.setProjectId).to.not.have.been.called;
  });

  it('warns and returns false when the referenced project is missing', async () => {
    Project.findById.resolves(null);
    const site = makeSite({ projectId: 'gone' });
    const mutated = await reparentSiteProjectToOrg(site, TARGET_ORG, context);
    expect(mutated).to.be.false;
    expect(log.warn).to.have.been.calledWithMatch(/missing project/);
    expect(Site.allByProjectId).to.not.have.been.called;
  });

  it('returns false when the project already lives in the target org', async () => {
    const project = makeProject(TARGET_ORG);
    Project.findById.resolves(project);
    const site = makeSite({ projectId: 'project-1' });
    const mutated = await reparentSiteProjectToOrg(site, TARGET_ORG, context);
    expect(mutated).to.be.false;
    expect(Site.allByProjectId).to.not.have.been.called;
    expect(project.setOrganizationId).to.not.have.been.called;
    expect(site.setProjectId).to.not.have.been.called;
  });

  it('moves the whole project (returns false) when the site is its only member', async () => {
    const project = makeProject(SOURCE_ORG);
    Project.findById.resolves(project);
    const site = makeSite({ projectId: 'project-1' });
    Site.allByProjectId.resolves([site]);

    const mutated = await reparentSiteProjectToOrg(site, TARGET_ORG, context);

    // Solo move persists the project itself, not the site.
    expect(mutated).to.be.false;
    expect(project.setOrganizationId).to.have.been.calledWith(TARGET_ORG);
    expect(project.save).to.have.been.called;
    expect(site.setProjectId).to.not.have.been.called;
    expect(Project.create).to.not.have.been.called;
  });

  it('splits into a new target-org project (returns true) when the project is shared', async () => {
    const project = makeProject(SOURCE_ORG);
    Project.findById.resolves(project);
    const site = makeSite({ projectId: 'project-1' });
    const sibling = makeSite({ id: 'sibling' });
    Site.allByProjectId.resolves([site, sibling]);
    Project.create.resolves({ getId: () => 'new-project', getProjectName: () => 'example.com' });

    const mutated = await reparentSiteProjectToOrg(site, TARGET_ORG, context);

    // Split repoints the site, so the caller must persist it.
    expect(mutated).to.be.true;
    expect(project.setOrganizationId).to.not.have.been.called;
    expect(Project.create).to.have.been.calledWithMatch({ organizationId: TARGET_ORG });
    expect(site.setProjectId).to.have.been.calledWith('new-project');
  });
});
