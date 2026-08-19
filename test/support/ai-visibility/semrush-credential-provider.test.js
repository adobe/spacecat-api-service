/* eslint-disable header/header */
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
import chaiAsPromised from 'chai-as-promised';

import {
  createDualModeSemrushCredentialProvider,
  CredentialGranularity,
  WorkspaceSource,
  DEFAULT_DUAL_MODE_CONFIG,
} from '../../../src/support/ai-visibility/semrush-credential-provider.js';
import {
  resolveSemrushCredential,
  setSemrushCredentialProvider,
  getCachedToken,
  resetSemrushCredentialCache,
} from '../../../src/support/ai-visibility/semrush-credential-resolver.js';

use(chaiAsPromised);

describe('semrush-credential-provider (dual-mode)', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
    // Restore the seam to its inert default between tests.
    setSemrushCredentialProvider(null);
    resetSemrushCredentialCache();
  });

  describe('seam stays inert by default', () => {
    it('importing this module registers no provider (resolver still returns null)', () => {
      // Merely building/importing the dual-mode provider must not wire it in.
      expect(resolveSemrushCredential({ imsOrgId: 'org-1' }, {})).to.equal(null);
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        lookupWorkspaceForOrg: sandbox.stub().returns('ws'),
      });
      expect(provider).to.be.a('function');
      // Still inert -- nothing installed it.
      expect(resolveSemrushCredential({ imsOrgId: 'org-1' }, {})).to.equal(null);
    });
  });

  describe('construction', () => {
    it('defaults to per-org TA + ims_org_id -> workspace mapping', () => {
      expect(DEFAULT_DUAL_MODE_CONFIG).to.deep.equal({
        credentialGranularity: CredentialGranularity.PER_ORG,
        workspaceSource: WorkspaceSource.TOKEN_ORG_MAPPING,
      });
    });

    it('requires a mintToken seam', () => {
      expect(() => createDualModeSemrushCredentialProvider({}))
        .to.throw(/mintToken must be a function/);
    });

    it('requires a lookupWorkspaceForOrg seam for token-org-mapping mode', () => {
      expect(() => createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: { workspaceSource: WorkspaceSource.TOKEN_ORG_MAPPING },
      })).to.throw(/requires a lookupWorkspaceForOrg seam/);
    });

    it('rejects an unknown credentialGranularity', () => {
      expect(() => createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: { credentialGranularity: 'nope', workspaceSource: WorkspaceSource.REQUEST },
      })).to.throw(/unknown credentialGranularity/);
    });

    it('rejects an unknown workspaceSource', () => {
      expect(() => createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: { workspaceSource: 'nope' },
      })).to.throw(/unknown workspaceSource/);
    });

    it('does not require lookupWorkspaceForOrg in request mode', () => {
      expect(() => createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: { workspaceSource: WorkspaceSource.REQUEST },
      })).to.not.throw();
    });
  });

  describe('default mode (per-org TA + token-org mapping)', () => {
    let mintToken;
    let lookupWorkspaceForOrg;
    let provider;

    beforeEach(() => {
      mintToken = sandbox.stub().resolves('minted-token');
      lookupWorkspaceForOrg = sandbox.stub()
        .callsFake((org) => (org === 'org-42' ? 'ws-42' : null));
      provider = createDualModeSemrushCredentialProvider({ mintToken, lookupWorkspaceForOrg });
    });

    it('keys the credential per org and maps org -> workspace', () => {
      const cred = provider({ imsOrgId: 'org-42' }, { E: 1 });

      expect(cred).to.not.equal(null);
      expect(cred.key).to.equal('semrush-ta:org:org-42');
      expect(cred.workspaceHint).to.equal('ws-42');
      expect(lookupWorkspaceForOrg.calledOnceWith('org-42')).to.be.true;
    });

    it('returns null (falls back to the shared path) when no org is resolvable', () => {
      expect(provider('brand-1', {})).to.equal(null); // bare string carries no org
      expect(provider({}, {})).to.equal(null);
      expect(mintToken.notCalled).to.be.true;
      expect(lookupWorkspaceForOrg.notCalled).to.be.true;
    });

    it('getAuthToken mints for the resolved scope with the request env', async () => {
      const env = { SECRET: 'x' };
      const cred = provider({ imsOrgId: 'org-42' }, env);

      const token = await cred.getAuthToken(env);

      expect(token).to.equal('minted-token');
      const [scope, passedEnv] = mintToken.firstCall.args;
      expect(scope.credentialKey).to.equal('semrush-ta:org:org-42');
      expect(scope.granularity).to.equal(CredentialGranularity.PER_ORG);
      expect(scope.imsOrgId).to.equal('org-42');
      expect(scope.workspaceId).to.equal('ws-42');
      expect(passedEnv).to.equal(env);
    });

    it('never hardcodes a mapping -- an unmapped org yields no workspaceHint', () => {
      const cred = provider({ imsOrgId: 'org-x' }, {});
      expect(cred.key).to.equal('semrush-ta:org:org-x');
      expect(cred.workspaceHint).to.equal(undefined);
    });
  });

  describe('Knob A -- credential granularity', () => {
    it('shared TA uses one constant key and needs no org', () => {
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: {
          credentialGranularity: CredentialGranularity.SHARED,
          workspaceSource: WorkspaceSource.REQUEST,
        },
      });

      const c1 = provider({ workspaceId: 'ws-1' }, {});
      const c2 = provider({ imsOrgId: 'org-9', workspaceId: 'ws-2' }, {});

      expect(c1.key).to.equal('semrush-ta:shared');
      expect(c2.key).to.equal('semrush-ta:shared');
    });
  });

  describe('Knob B -- workspace selection', () => {
    it('request mode reads workspaceHint from the request context', () => {
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        config: {
          credentialGranularity: CredentialGranularity.PER_ORG,
          workspaceSource: WorkspaceSource.REQUEST,
        },
      });

      const cred = provider({ imsOrgId: 'org-1', workspaceId: 'ws-req' }, {});

      expect(cred.key).to.equal('semrush-ta:org:org-1');
      expect(cred.workspaceHint).to.equal('ws-req');
    });

    it('honors injected org + request-workspace resolvers (opaque brand, no hardcoding)', () => {
      const resolveOrgId = sandbox.stub().returns('org-inj');
      const resolveRequestWorkspace = sandbox.stub().returns('ws-inj');
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        resolveOrgId,
        resolveRequestWorkspace,
        config: { workspaceSource: WorkspaceSource.REQUEST },
      });

      const cred = provider('opaque-brand', { E: 1 });

      expect(resolveOrgId.calledOnceWith('opaque-brand', { E: 1 })).to.be.true;
      expect(cred.key).to.equal('semrush-ta:org:org-inj');
      expect(cred.workspaceHint).to.equal('ws-inj');
    });
  });

  it('supports both contested shapes from one set of seams via config alone', () => {
    const seams = {
      mintToken: sandbox.stub().resolves('t'),
      lookupWorkspaceForOrg: sandbox.stub().returns('ws-mapped'),
      resolveOrgId: () => 'org-7',
      resolveRequestWorkspace: () => 'ws-body',
    };

    const perOrgMapping = createDualModeSemrushCredentialProvider({
      ...seams,
      config: {
        credentialGranularity: CredentialGranularity.PER_ORG,
        workspaceSource: WorkspaceSource.TOKEN_ORG_MAPPING,
      },
    });
    const sharedRequest = createDualModeSemrushCredentialProvider({
      ...seams,
      config: {
        credentialGranularity: CredentialGranularity.SHARED,
        workspaceSource: WorkspaceSource.REQUEST,
      },
    });

    const a = perOrgMapping({}, {});
    const b = sharedRequest({}, {});

    expect(a.key).to.equal('semrush-ta:org:org-7');
    expect(a.workspaceHint).to.equal('ws-mapped');
    expect(b.key).to.equal('semrush-ta:shared');
    expect(b.workspaceHint).to.equal('ws-body');
  });

  describe('diagnostic logging on fall-back paths', () => {
    it('logs distinct reasons for the missing-org and unmapped-workspace paths', () => {
      const log = { debug: sandbox.stub() };
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        lookupWorkspaceForOrg: sandbox.stub().returns(null),
        log,
      });

      // per-org + no org -> null (cannot scope a per-org credential).
      expect(provider('brand-string', {})).to.equal(null);
      // org present but unmapped -> descriptor without workspaceHint (distinct reason).
      const cred = provider({ imsOrgId: 'org-1' }, {});
      expect(cred.workspaceHint).to.equal(undefined);

      const messages = log.debug.getCalls().map((c) => c.args[0]);
      expect(messages.some((m) => /cannot scope a per-org credential/.test(m))).to.be.true;
      expect(messages.some((m) => /has no mapped workspace/.test(m))).to.be.true;
    });

    it('logs the workspace-mapping reason when mapping mode has no org (shared key)', () => {
      const log = { debug: sandbox.stub() };
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        lookupWorkspaceForOrg: sandbox.stub().returns('ws'),
        log,
        config: {
          credentialGranularity: CredentialGranularity.SHARED,
          workspaceSource: WorkspaceSource.TOKEN_ORG_MAPPING,
        },
      });

      // Shared key needs no org, but mapping mode does -> null (cannot map a workspace).
      expect(provider('brand-no-org', {})).to.equal(null);
      const messages = log.debug.getCalls().map((c) => c.args[0]);
      expect(messages.some((m) => /cannot map a workspace/.test(m))).to.be.true;
    });

    it('is silent when no logger is injected', () => {
      const provider = createDualModeSemrushCredentialProvider({
        mintToken: sandbox.stub().resolves('t'),
        lookupWorkspaceForOrg: sandbox.stub().returns(null),
      });
      // No throw despite the fall-back paths firing without a logger.
      expect(provider('brand-string', {})).to.equal(null);
      expect(provider({ imsOrgId: 'org-1' }, {}).workspaceHint).to.equal(undefined);
    });
  });

  describe('installed into the resolver seam', () => {
    it('resolves per-brand and shares one mint per credential key via getCachedToken', async () => {
      const mintToken = sandbox.stub().resolves({ token: 'org-tok', expiresInMs: 60 * 1000 });
      const lookupWorkspaceForOrg = sandbox.stub().returns('ws');
      const provider = createDualModeSemrushCredentialProvider({
        mintToken,
        lookupWorkspaceForOrg,
      });
      setSemrushCredentialProvider(provider);

      const cred = resolveSemrushCredential({ imsOrgId: 'org-42' }, {});
      expect(cred.key).to.equal('semrush-ta:org:org-42');

      // Two reads within TTL -> a single mint, exactly as the transport interceptor drives it.
      const t1 = await getCachedToken(cred.key, () => cred.getAuthToken({}), 0);
      const t2 = await getCachedToken(cred.key, () => cred.getAuthToken({}), 1000);

      expect(t1).to.equal('org-tok');
      expect(t2).to.equal('org-tok');
      expect(mintToken.calledOnce).to.be.true;
    });
  });
});
