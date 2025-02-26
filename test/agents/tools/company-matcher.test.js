/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import { matchCompanies } from '../../../src/agents/org-detector/tools/company-matcher.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('org-detection-agent/company matcher', () => {
  let context;
  let orgs;

  beforeEach('setup', () => {
    context = {
      dataAccess: {
        Organization: {
          all: sandbox.stub(),
        },
      },
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    orgs = [
      {
        getId: () => 'org-1',
        getName: () => 'Adobe Systems Inc',
        getImsOrgId: () => 'ims-org-1',
      },
      {
        getId: () => 'org-2',
        getName: () => 'SpaceCat Ventures',
        getImsOrgId: () => 'ims-org-2',
      },
      {
        getId: () => 'org-3',
        getName: () => 'Ace Ventura Inc.',
        getImsOrgId: () => 'ims-org-3',
      },
      {
        getId: () => 'org-4',
        getName: () => 'Another Org',
        getImsOrgId: () => 'ims-org-3',
      },
    ];
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns matching organizations', async () => {
    // Arrange
    context.dataAccess.Organization.all.resolves(orgs);

    // Act
    const query = 'AdobeSystems';
    const result = await matchCompanies(context.dataAccess, query);

    // Assert
    expect(context.dataAccess.Organization.all).to.have.been.calledOnce;
    expect(result).to.be.an('array').with.lengthOf(1);
    expect(result[0]).to.deep.equal({
      id: 'org-1',
      name: 'Adobe Systems Inc',
      imsOrgId: 'ims-org-1',
    });
  });

  it('returns fuzzy match organizations found in DB', async () => {
    // Arrange
    context.dataAccess.Organization.all.resolves(orgs);

    // Act
    const result = await matchCompanies(context.dataAccess, 'Ventur');

    // Assert
    expect(context.dataAccess.Organization.all).to.have.been.calledOnce;
    expect(result).to.be.an('array').with.lengthOf(2);
    expect(result[0]).to.deep.equal({
      id: 'org-2',
      imsOrgId: 'ims-org-2',
      name: 'SpaceCat Ventures',
    });
    expect(result[1]).to.deep.equal({
      id: 'org-3',
      imsOrgId: 'ims-org-3',
      name: 'Ace Ventura Inc.',
    });
  });

  it('returns empty array if no organizations found in DB', async () => {
    // Arrange
    context.dataAccess.Organization.all.resolves([]);

    // Act
    const result = await matchCompanies(context.dataAccess, 'AnyQuery');

    // Assert
    expect(context.dataAccess.Organization.all).to.have.been.calledOnce;
    expect(result).to.be.an('array').that.is.empty;
  });
});
