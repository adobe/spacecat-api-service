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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('EnrichBrandClaimsCommand', () => {
  let context;
  let slackContext;
  let triggerBrandClaimsEnrichStub;
  let findByBaseURLStub;
  let mockSite;
  let EnrichBrandClaimsCommand;

  const SITE_ID = '11111111-1111-4111-8111-111111111111';

  before(async () => {
    triggerBrandClaimsEnrichStub = sinon.stub();
    EnrichBrandClaimsCommand = await esmock(
      '../../../../src/support/slack/commands/enrich-brand-claims.js',
      {
        '../../../../src/support/utils.js': {
          triggerBrandClaimsEnrich: triggerBrandClaimsEnrichStub,
        },
      },
    );
  });

  beforeEach(() => {
    triggerBrandClaimsEnrichStub.reset();
    triggerBrandClaimsEnrichStub.resolves();
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://example.com',
    };
    findByBaseURLStub = sinon.stub().resolves(mockSite);
    context = {
      dataAccess: { Site: { findByBaseURL: findByBaseURLStub } },
      log: { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() },
    };
    slackContext = { say: sinon.spy(), channelId: 'C1', threadTs: 'T1' };
  });

  it('registers the enrich-brand-claims phrase', () => {
    const command = EnrichBrandClaimsCommand(context);
    expect(command.phrases).to.include('enrich-brand-claims');
  });

  it('triggers the enrich run for a valid site URL', async () => {
    const command = EnrichBrandClaimsCommand(context);
    await command.execute('enrich-brand-claims https://example.com', slackContext);

    expect(findByBaseURLStub).to.have.been.calledWith('https://example.com');
    expect(triggerBrandClaimsEnrichStub).to.have.been.calledOnce;
    expect(triggerBrandClaimsEnrichStub.firstCall.args[0]).to.equal(mockSite);
    expect(triggerBrandClaimsEnrichStub.firstCall.args[1]).to.equal(slackContext);
    expect(triggerBrandClaimsEnrichStub.firstCall.args[2]).to.equal(context);
    expect(slackContext.say.firstCall.args[0]).to.include('off-site opportunity');
  });

  it('warns and does not trigger for a missing/invalid URL', async () => {
    const command = EnrichBrandClaimsCommand(context);
    await command.execute('enrich-brand-claims', slackContext);

    expect(triggerBrandClaimsEnrichStub).to.not.have.been.called;
    expect(slackContext.say.firstCall.args[0]).to.include(':warning:');
  });

  it('reports site-not-found and does not trigger', async () => {
    findByBaseURLStub.resolves(null);
    const command = EnrichBrandClaimsCommand(context);
    await command.execute('enrich-brand-claims https://unknown.com', slackContext);

    expect(triggerBrandClaimsEnrichStub).to.not.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });

  it('surfaces an error if the trigger throws', async () => {
    triggerBrandClaimsEnrichStub.rejects(new Error('sqs down'));
    const command = EnrichBrandClaimsCommand(context);
    await command.execute('enrich-brand-claims https://example.com', slackContext);

    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });
});
