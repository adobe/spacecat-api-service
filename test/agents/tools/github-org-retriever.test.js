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
import nock from 'nock';
import esmock from 'esmock';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('org-detection-agent/github org retriever', () => {
  let context;
  let ignoredOrgs;
  let mockOctokit;
  let getGithubOrgName;

  beforeEach(async () => {
    context = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
    };
    ignoredOrgs = ['ignored-org'];

    mockOctokit = {
      rest: {
        orgs: {
          get: sandbox.stub(),
        },
      },
    };

    const mockedModule = await esmock(
      '../../../src/agents/org-detector/tools/github-org-retriever.js',
      {
        '@octokit/rest': {
          Octokit: class MockOctokit {
            constructor() {
              // eslint-disable-next-line no-constructor-return
              return mockOctokit;
            }
          },
        },
      },
    );

    getGithubOrgName = mockedModule.getGithubOrgName;
  });

  afterEach(async () => {
    sandbox.restore();
    nock.cleanAll();
    await esmock.purge();
  });

  it('returns null if orgLogin is in the ignored list', async () => {
    const result = await getGithubOrgName('ignored-org', ignoredOrgs, context.log);
    expect(context.log.info).to.have.been.calledWith('Organization ignored-org is in the ignored list.');
    expect(result).to.be.null;
  });

  it('returns the organization name from Octokit if call is successful', async () => {
    mockOctokit.rest.orgs.get.resolves({ data: { name: 'Adobe' } });
    const result = await getGithubOrgName('adobe', ignoredOrgs, context.log);
    expect(mockOctokit.rest.orgs.get).to.have.been.calledOnceWith({ org: 'adobe' });
    expect(result).to.equal('Adobe');
  });

  it('falls back to scraping for 4xx errors', async () => {
    mockOctokit.rest.orgs.get.rejects({ status: 404, message: 'Not Found' });
    nock('https://github.com')
      .get('/spacecat')
      .reply(200, `
        <html>
          <body>
            <h1 class="sso-title">
              <strong>SpaceCat Org</strong>
            </h1>
          </body>
        </html>
      `);
    const result = await getGithubOrgName('spacecat', ignoredOrgs, context.log);
    expect(context.log.info).to.have.been.calledWith('Falling back to scraping for organization spacecat...');
    expect(result).to.equal('SpaceCat Org');
  });

  it('returns null if scraping fails or the element is missing', async () => {
    mockOctokit.rest.orgs.get.rejects({ status: 404, message: 'Not Found' });
    nock('https://github.com')
      .get('/mysteryorg')
      .reply(200, '<html><body><h1>No strong org name</h1></body></html>');
    const result = await getGithubOrgName('mysteryorg', ignoredOrgs, context.log);
    expect(result).to.be.null;
  });

  it('returns null if an unexpected error occurs with Octokit', async () => {
    mockOctokit.rest.orgs.get.rejects({ status: 500, message: 'Server Error' });
    const result = await getGithubOrgName('anyorg', ignoredOrgs, context.log);
    expect(context.log.error).to.have.been.calledWithMatch(/Error fetching organization name for anyorg: Server Error/);
    expect(result).to.be.null;
  });
});
