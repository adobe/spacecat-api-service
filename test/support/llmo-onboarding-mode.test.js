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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  readBrandalfFlagOverride,
  readBrandalfMigrationFlagOverride,
  resolveLlmoOnboardingMode,
} from '../../src/support/llmo-onboarding-mode.js';

use(sinonChai);
use(chaiAsPromised);

/**
 * Builds a postgrestClient stub whose feature_flags read returns the given value.
 * Pass `null` to simulate a missing row, `'throw'` to simulate a DB error.
 */
function makePostgrestClient(brandalfValue) {
  if (brandalfValue === undefined) {
    return undefined;
  }
  // Org-row lookup: from().select().eq().eq().eq() resolves to the matching rows.
  const flagRows = brandalfValue === 'throw'
    ? { data: null, error: { message: 'boom' } }
    : {
      data: brandalfValue === null ? [] : [{ id: 'flag-row-1', flag_value: brandalfValue }],
      error: null,
    };
  const readSelect = sinon.stub().returns({
    eq: sinon.stub().returns({
      eq: sinon.stub().returns({
        eq: sinon.stub().resolves(flagRows),
      }),
    }),
  });

  return {
    from: sinon.stub().returns({ select: readSelect }),
  };
}

function makeContext({ env = {}, brandalfValue } = {}) {
  const ctx = {
    env: { ...env },
    log: { warn: sinon.stub(), error: sinon.stub(), info: sinon.stub() },
    dataAccess: {
      // The resolver no longer reads sites — kept as a spy so tests can assert
      // the legacy-site lookup is never performed (LLMO-7108).
      Site: { allByOrganizationId: sinon.stub().resolves([]) },
    },
  };
  const postgrestClient = makePostgrestClient(brandalfValue);
  if (postgrestClient) {
    ctx.dataAccess.services = { postgrestClient };
  }
  return ctx;
}

describe('llmo-onboarding-mode', () => {
  afterEach(() => sinon.restore());

  // ── readBrandalfFlagOverride ──────────────────────────────────────────────

  describe('readBrandalfFlagOverride', () => {
    it('reads the brandalf flag from feature_flags', async () => {
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().resolves({ data: [{ flag_value: true }], error: null }),
              }),
            }),
          }),
        }),
      };

      const result = await readBrandalfFlagOverride('org-1', postgrestClient);
      expect(result).to.equal(true);
      expect(postgrestClient.from).to.have.been.calledWith('feature_flags');
    });

    it('returns null when called without arguments', async () => {
      expect(await readBrandalfFlagOverride()).to.equal(null);
    });

    it('returns null when postgrestClient has no .from', async () => {
      expect(await readBrandalfFlagOverride('org-1', {})).to.equal(null);
    });

    it('returns null when flag_value is not a boolean', async () => {
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().resolves({ data: [{ flag_value: 'true' }], error: null }),
              }),
            }),
          }),
        }),
      };

      expect(await readBrandalfFlagOverride('org-1', postgrestClient)).to.equal(null);
    });

    it('throws when the DB returns an error', async () => {
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().resolves({ data: null, error: { message: 'boom' } }),
              }),
            }),
          }),
        }),
      };

      await expect(readBrandalfFlagOverride('org-1', postgrestClient))
        .to.be.rejectedWith('Failed to read feature flag brandalf: boom');
    });
  });

  // ── readBrandalfMigrationFlagOverride ─────────────────────────────────────

  describe('readBrandalfMigrationFlagOverride', () => {
    it('reads the brandalf_migration flag from feature_flags', async () => {
      const eqStub3 = sinon.stub().resolves({ data: [{ flag_value: true }], error: null });
      const eqStub2 = sinon.stub().returns({ eq: eqStub3 });
      const eqStub1 = sinon.stub().returns({ eq: eqStub2 });
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({ eq: eqStub1 }),
        }),
      };

      const result = await readBrandalfMigrationFlagOverride('org-1', postgrestClient);
      expect(result).to.equal(true);
      expect(postgrestClient.from).to.have.been.calledWith('feature_flags');
      // Last eq() call must filter on flag_name='brandalf_migration'
      expect(eqStub3).to.have.been.calledWith('flag_name', 'brandalf_migration');
    });

    it('returns null when called without arguments', async () => {
      expect(await readBrandalfMigrationFlagOverride()).to.equal(null);
    });

    it('returns null when postgrestClient has no .from', async () => {
      expect(await readBrandalfMigrationFlagOverride('org-1', {})).to.equal(null);
    });
  });

  // ── resolveLlmoOnboardingMode ─────────────────────────────────────────────
  // The legacy-site cutoff was removed in LLMO-7108. The resolver now decides:
  //   1. brandalf=true            → v2
  //   2. brandalf_migration=true  → v2
  //   3. LLMO_ONBOARDING_DEFAULT_VERSION==='v1' (kill switch) → v1
  //   4. otherwise                → v2

  describe('resolveLlmoOnboardingMode', () => {
    // ── Brandalf flag → v2 ─────────────────────────────────────────────────

    describe('brandalf flag override', () => {
      it('returns v2 when brandalf=true', async () => {
        const ctx = makeContext({ brandalfValue: true });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.info).to.have.been.calledWithMatch(/brandalf=true.*using v2/);
      });

      it('returns v2 when brandalf=true even with the kill switch active', async () => {
        // LLMO-7108: without the legacy-site cutoff there is no row-1
        // remediation — an explicitly migrated org is always honored as v2.
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
      });

      it('never reads the org sites (legacy-site cutoff removed)', async () => {
        const ctx = makeContext({ brandalfValue: true });
        await resolveLlmoOnboardingMode('org-1', ctx);
        expect(ctx.dataAccess.Site.allByOrganizationId).to.not.have.been.called;
      });

      it('falls through to default resolution when the brandalf flag read fails', async () => {
        const ctx = makeContext({ brandalfValue: 'throw' });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to read brandalf flag/);
      });
    });

    // ── Kill switch — no brandalf flag ─────────────────────────────────────

    describe('kill switch — no brandalf flag', () => {
      it('returns v1 when the kill switch is active and the flag row is missing', async () => {
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('returns v1 when the kill switch is active and brandalf=false', async () => {
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: false,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
        // brandalf=false → kill switch → v1 without any site lookup.
        expect(ctx.dataAccess.Site.allByOrganizationId).to.not.have.been.called;
      });
    });

    // ── Default v2 — no brandalf flag ──────────────────────────────────────

    describe('default v2 — no brandalf flag', () => {
      it('returns v2 when brandalf is unset and no kill switch is configured', async () => {
        const ctx = makeContext({ brandalfValue: null });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v2 when brandalf=false and no kill switch is configured', async () => {
        const ctx = makeContext({ brandalfValue: false });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v2 when LLMO_ONBOARDING_DEFAULT_VERSION is explicitly v2', async () => {
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v2' },
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });
    });

    // ── Edge cases ─────────────────────────────────────────────────────────

    describe('edge cases', () => {
      it('returns v2 when no context is provided', async () => {
        const mode = await resolveLlmoOnboardingMode('org-1');
        expect(mode).to.equal('v2');
      });

      it('warns and falls back to v2 for invalid LLMO_ONBOARDING_DEFAULT_VERSION', async () => {
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'banana' },
          brandalfValue: null,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWith(
          'Invalid LLMO_ONBOARDING_DEFAULT_VERSION "banana", falling back to v2',
        );
      });
    });

    // ── brandalf_migration short-circuit (LLMO-4716) ──────────────────────

    /**
     * Postgrest stub that returns different flag values based on which flag
     * is being queried (third `.eq()` call captures the flag_name). Used to
     * test the brandalf_migration short-circuit, which requires reading
     * brandalf and brandalf_migration independently.
     */
    function makeMultiFlagContext(flags) {
      const flagNameEq = sinon.stub().callsFake((field, flagName) => {
        const value = field === 'flag_name' ? flags[flagName] : undefined;
        return Promise.resolve({
          data: value === null || value === undefined ? [] : [{ flag_value: value }],
          error: null,
        });
      });
      const productEq = sinon.stub().returns({ eq: flagNameEq });
      const orgEq = sinon.stub().returns({ eq: productEq });
      const select = sinon.stub().returns({ eq: orgEq });
      const postgrestClient = {
        from: sinon.stub().returns({ select }),
      };
      return {
        env: {},
        log: { warn: sinon.stub(), error: sinon.stub(), info: sinon.stub() },
        dataAccess: {
          Site: { allByOrganizationId: sinon.stub().resolves([]) },
          services: { postgrestClient },
        },
      };
    }

    describe('brandalf_migration short-circuit', () => {
      it('returns v2 when brandalf_migration=true and brandalf is unset', async () => {
        const ctx = makeMultiFlagContext({
          brandalf: null,
          brandalf_migration: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.info).to.have.been.calledWithMatch(/brandalf_migration=true.*using v2/);
        // Short-circuit: site lookup must not happen.
        expect(ctx.dataAccess.Site.allByOrganizationId).to.not.have.been.called;
      });

      it('skips migration read when brandalf=true (brandalf wins normal path)', async () => {
        const ctx = makeMultiFlagContext({
          brandalf: true,
          brandalf_migration: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        // The brandalf=true branch logs "using v2" — not the migration branch.
        expect(ctx.log.info).to.have.been.calledWithMatch(/brandalf=true.*using v2/);
        expect(ctx.log.info).to.not.have.been.calledWithMatch(/brandalf_migration=true.*using v2/);
      });

      it('runs BEFORE the env-level kill switch so ops cannot pin a migrating org back to v1', async () => {
        const ctx = makeMultiFlagContext({
          brandalf: null,
          brandalf_migration: true,
        });
        ctx.env.LLMO_ONBOARDING_DEFAULT_VERSION = 'v1';
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
      });

      it('returns v2 when brandalf_migration=false and no kill switch is configured', async () => {
        const ctx = makeMultiFlagContext({ brandalf: null, brandalf_migration: false });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
      });

      it('warns and falls through when brandalf_migration read throws', async () => {
        const flagNameEq = sinon.stub();
        // First call: brandalf read finds no row
        flagNameEq.onFirstCall().resolves({ data: [], error: null });
        // Second call: brandalf_migration read returns a DB error
        flagNameEq.onSecondCall().resolves({ data: null, error: { message: 'boom' } });
        const productEq = sinon.stub().returns({ eq: flagNameEq });
        const orgEq = sinon.stub().returns({ eq: productEq });
        const select = sinon.stub().returns({ eq: orgEq });
        const ctx = {
          env: {},
          log: { warn: sinon.stub(), error: sinon.stub(), info: sinon.stub() },
          dataAccess: {
            Site: { allByOrganizationId: sinon.stub().resolves([]) },
            services: { postgrestClient: { from: sinon.stub().returns({ select }) } },
          },
        };
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        // Defaults to v2 via the no-kill-switch fallthrough.
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to read brandalf_migration flag/);
      });
    });
  });
});
