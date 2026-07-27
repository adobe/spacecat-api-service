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

describe('BrandClaimsCommand', () => {
  let context;
  let slackContext;
  let setBrandClaimsEnabledStub;
  let BrandClaimsCommand;

  const BRAND_ID = 'a1b2c3d4-5678-90ab-cdef-1234567890ab';
  const BRAND = { id: BRAND_ID, name: 'Acme' };

  before(async () => {
    setBrandClaimsEnabledStub = sinon.stub();
    BrandClaimsCommand = await esmock(
      '../../../../src/support/slack/commands/toggle-brand-claims.js',
      {
        '../../../../src/support/brands-storage.js': {
          setBrandClaimsEnabled: setBrandClaimsEnabledStub,
        },
      },
    );
  });

  beforeEach(() => {
    setBrandClaimsEnabledStub.reset();
    context = {
      dataAccess: { services: { postgrestClient: { from: sinon.stub() } } },
      log: console,
    };
    slackContext = { say: sinon.spy(), user: 'U123' };
  });

  describe('Initialization', () => {
    it('registers both keyword phrases', () => {
      const command = BrandClaimsCommand(context);
      expect(command.id).to.equal('brand-claims');
      expect(command.name).to.equal('Brand Claims');
      expect(command.phrases).to.deep.equal(['enable-brand-claims', 'disable-brand-claims']);
    });
  });

  describe('Execute', () => {
    it('enables brand claims when the enable keyword is used', async () => {
      setBrandClaimsEnabledStub.resolves(BRAND);

      const command = BrandClaimsCommand(context);
      await command.execute(`enable-brand-claims ${BRAND_ID}`, slackContext);

      const args = setBrandClaimsEnabledStub.firstCall.args[0];
      expect(args.brandId).to.equal(BRAND_ID);
      expect(args.enabled).to.equal(true);
      expect(args.updatedBy).to.equal('slack:U123');
      expect(slackContext.say.calledWithMatch(/Brand claims \*enabled\* for brand "Acme"/)).to.be.true;
    });

    it('disables brand claims when the disable keyword is used', async () => {
      setBrandClaimsEnabledStub.resolves(BRAND);

      const command = BrandClaimsCommand(context);
      await command.execute(`disable-brand-claims ${BRAND_ID}`, slackContext);

      const args = setBrandClaimsEnabledStub.firstCall.args[0];
      expect(args.enabled).to.equal(false);
      expect(slackContext.say.calledWithMatch(/Brand claims \*disabled\* for brand "Acme"/)).to.be.true;
    });

    it('warns when no brand ID is provided', async () => {
      const command = BrandClaimsCommand(context);
      await command.execute('enable-brand-claims', slackContext);

      expect(slackContext.say.calledWithMatch(/Please provide a brand ID/)).to.be.true;
      expect(setBrandClaimsEnabledStub).to.not.have.been.called;
    });

    it('rejects a brand ID that is not a valid UUID', async () => {
      const command = BrandClaimsCommand(context);
      await command.execute('enable-brand-claims not-a-uuid', slackContext);

      expect(slackContext.say.calledWithMatch(/not a valid brand ID/)).to.be.true;
      expect(setBrandClaimsEnabledStub).to.not.have.been.called;
    });

    it('errors when the postgrest client is unavailable', async () => {
      context.dataAccess.services.postgrestClient = { from: undefined };

      const command = BrandClaimsCommand(context);
      await command.execute(`enable-brand-claims ${BRAND_ID}`, slackContext);

      expect(slackContext.say.calledWithMatch(/Brand storage is not available/)).to.be.true;
      expect(setBrandClaimsEnabledStub).to.not.have.been.called;
    });

    it('warns when no brand matches the ID', async () => {
      setBrandClaimsEnabledStub.resolves(null);

      const command = BrandClaimsCommand(context);
      await command.execute(`enable-brand-claims ${BRAND_ID}`, slackContext);

      expect(slackContext.say.calledWithMatch(/No brand found with ID/)).to.be.true;
    });

    it('falls back to a generic updatedBy when no Slack user is present', async () => {
      setBrandClaimsEnabledStub.resolves(BRAND);
      slackContext.user = undefined;

      const command = BrandClaimsCommand(context);
      await command.execute(`disable-brand-claims ${BRAND_ID}`, slackContext);

      expect(setBrandClaimsEnabledStub.firstCall.args[0].updatedBy).to.equal('slack');
    });

    it('handles errors during execution', async () => {
      setBrandClaimsEnabledStub.rejects(new Error('Test Error'));

      const command = BrandClaimsCommand(context);
      await command.execute(`enable-brand-claims ${BRAND_ID}`, slackContext);

      expect(slackContext.say.calledWithMatch(/Something went wrong: Test Error/)).to.be.true;
    });
  });
});
