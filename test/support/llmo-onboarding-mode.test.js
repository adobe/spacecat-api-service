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
  LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT,
  hasPreBrandalfSites,
  readBrandalfFlagOverride,
  resolveBrandalfCutoffMs,
  resolveLlmoOnboardingMode,
} from '../../src/support/llmo-onboarding-mode.js';

use(sinonChai);
use(chaiAsPromised);

// 2026-04-01T00:00:00Z in ms — matches the default constant
const CUTOFF = LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT;
const BEFORE_CUTOFF = new Date(CUTOFF - 1).toISOString(); // 2026-03-31T23:59:59.999Z
const AT_CUTOFF = new Date(CUTOFF).toISOString(); // 2026-04-01T00:00:00.000Z
const AFTER_CUTOFF = new Date(CUTOFF + 86400000).toISOString(); // 2026-04-02T00:00:00.000Z

function makeSite(createdAt, id = 'site-id') {
  return { getCreatedAt: () => createdAt, getId: () => id };
}

/**
 * Builds a postgrestClient stub whose feature_flags read returns the given value.
 * Pass `null` to simulate a missing row, `'throw'` to simulate a DB error.
 * Also supports the upsert chain used by `upsertFeatureFlag`.
 */
function makePostgrestClient(brandalfValue) {
  if (brandalfValue === undefined) {
    return undefined;
  }
  const maybeSingle = brandalfValue === 'throw'
    ? sinon.stub().resolves({ data: null, error: { message: 'boom' } })
    : sinon.stub().resolves({
      data: brandalfValue === null ? null : { flag_value: brandalfValue },
      error: null,
    });

  // Upsert chain: from().upsert().select().single()
  const upsertSingle = sinon.stub().resolves({ data: { flag_value: false }, error: null });
  const upsertSelect = sinon.stub().returns({ single: upsertSingle });
  const upsert = sinon.stub().returns({ select: upsertSelect });

  // Read chain: from().select().eq().eq().eq().maybeSingle()
  const readSelect = sinon.stub().returns({
    eq: sinon.stub().returns({
      eq: sinon.stub().returns({
        eq: sinon.stub().returns({ maybeSingle }),
      }),
    }),
  });

  const client = {
    from: sinon.stub().returns({
      select: readSelect,
      upsert,
    }),
  };
  client.getUpsertStub = () => upsert;
  return client;
}

function makeContext({
  sites = [], env = {}, throwOnLookup = false, brandalfValue,
} = {}) {
  const ctx = {
    env: { LLMO_BRANDALF_GA_CUTOFF_MS: String(CUTOFF), ...env },
    log: { warn: sinon.stub(), error: sinon.stub(), info: sinon.stub() },
    dataAccess: {
      Site: {
        allByOrganizationId: throwOnLookup
          ? sinon.stub().rejects(new Error('DB error'))
          : sinon.stub().resolves(sites),
      },
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
      const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().returns({ maybeSingle }),
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
      const maybeSingle = sinon.stub().resolves({ data: { flag_value: 'true' }, error: null });
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().returns({ maybeSingle }),
              }),
            }),
          }),
        }),
      };

      expect(await readBrandalfFlagOverride('org-1', postgrestClient)).to.equal(null);
    });

    it('throws when the DB returns an error', async () => {
      const maybeSingle = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
      const postgrestClient = {
        from: sinon.stub().returns({
          select: sinon.stub().returns({
            eq: sinon.stub().returns({
              eq: sinon.stub().returns({
                eq: sinon.stub().returns({ maybeSingle }),
              }),
            }),
          }),
        }),
      };

      await expect(readBrandalfFlagOverride('org-1', postgrestClient))
        .to.be.rejectedWith('Failed to read feature flag brandalf: boom');
    });
  });

  // ── resolveBrandalfCutoffMs ───────────────────────────────────────────────

  describe('resolveBrandalfCutoffMs', () => {
    it('pins LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT to 2026-04-01T00:00:00Z', () => {
      // Guards against an off-by-one-year regression on the hard-coded fallback.
      expect(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT).to.equal(Date.UTC(2026, 3, 1));
    });

    it('returns the default when env var is not set', () => {
      expect(resolveBrandalfCutoffMs({ env: {} })).to.equal(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT);
    });

    it('returns the default when context is missing', () => {
      expect(resolveBrandalfCutoffMs()).to.equal(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT);
    });

    it('returns the parsed value from a valid env var string', () => {
      expect(resolveBrandalfCutoffMs({ env: { LLMO_BRANDALF_GA_CUTOFF_MS: '1000000000000' } }))
        .to.equal(1000000000000);
    });

    it('returns the default and warns for non-numeric env var', () => {
      const log = { warn: sinon.stub() };
      const result = resolveBrandalfCutoffMs({ env: { LLMO_BRANDALF_GA_CUTOFF_MS: 'abc' }, log });
      expect(result).to.equal(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT);
      expect(log.warn).to.have.been.called;
    });

    it('returns the default and warns for zero', () => {
      const log = { warn: sinon.stub() };
      const result = resolveBrandalfCutoffMs({ env: { LLMO_BRANDALF_GA_CUTOFF_MS: '0' }, log });
      expect(result).to.equal(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT);
      expect(log.warn).to.have.been.called;
    });

    it('returns the default and warns for a negative value', () => {
      const log = { warn: sinon.stub() };
      const result = resolveBrandalfCutoffMs({ env: { LLMO_BRANDALF_GA_CUTOFF_MS: '-1' }, log });
      expect(result).to.equal(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT);
      expect(log.warn).to.have.been.called;
    });
  });

  // ── hasPreBrandalfSites ───────────────────────────────────────────────────

  describe('hasPreBrandalfSites', () => {
    it('returns false when the org has no sites', async () => {
      const ctx = makeContext({ sites: [] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
    });

    it('returns true when at least one site predates the cutoff', async () => {
      const ctx = makeContext({ sites: [makeSite(BEFORE_CUTOFF)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(true);
    });

    it('returns false when the only site is exactly at the cutoff (exclusive comparison)', async () => {
      const ctx = makeContext({ sites: [makeSite(AT_CUTOFF)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
    });

    it('returns false when all sites are after the cutoff', async () => {
      const ctx = makeContext({ sites: [makeSite(AFTER_CUTOFF)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
    });

    it('returns true when multiple sites exist and one predates the cutoff', async () => {
      const ctx = makeContext({
        sites: [makeSite(AFTER_CUTOFF), makeSite(BEFORE_CUTOFF)],
      });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(true);
    });

    it('returns false for sites with null createdAt and warns', async () => {
      const ctx = makeContext({ sites: [makeSite(null)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/has no createdAt/);
    });

    it('returns false for sites with undefined createdAt and warns', async () => {
      const ctx = makeContext({ sites: [makeSite(undefined)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/has no createdAt/);
    });

    it('returns false for sites with invalid createdAt string and warns', async () => {
      const ctx = makeContext({ sites: [makeSite('not-a-date')] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/unparseable createdAt/);
    });

    it('falls back to <unknown> in the warn when site has no getId (null createdAt)', async () => {
      // Mirrors a partially-hydrated site model that exposes createdAt but not getId.
      const ctx = makeContext({ sites: [{ getCreatedAt: () => null }] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/Site <unknown>.*has no createdAt/);
    });

    it('falls back to <unknown> in the warn when site has no getId (invalid createdAt)', async () => {
      const ctx = makeContext({ sites: [{ getCreatedAt: () => 'not-a-date' }] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/Site <unknown>.*unparseable createdAt/);
    });

    it('accepts a Date object for createdAt', async () => {
      const ctx = makeContext({ sites: [makeSite(new Date(CUTOFF - 1))] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(true);
    });

    it('honours a custom LLMO_BRANDALF_GA_CUTOFF_MS from context.env', async () => {
      const customCutoff = new Date('2026-06-01T00:00:00Z').getTime();
      const ctx = makeContext({
        sites: [makeSite(AFTER_CUTOFF)], // after default cutoff but before custom cutoff
        env: { LLMO_BRANDALF_GA_CUTOFF_MS: String(customCutoff) },
      });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(true);
    });
  });

  // ── resolveLlmoOnboardingMode ─────────────────────────────────────────────
  // Tests are structured around the 8-row decision matrix
  // (see v1-v2-onboarding-consistency-safeguard.md).

  describe('resolveLlmoOnboardingMode', () => {
    // ── Brandalf flag override (rows 1, 3, 5, 7) ──────────────────────────

    describe('brandalf flag override', () => {
      it('row 1: kill switch + pre-cutoff + brandalf=true → v1, reverts flag to false', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
        // Flag was reverted
        expect(ctx.dataAccess.services.postgrestClient.getUpsertStub()).to.have.been.called;
        // Warning logged about migration
        expect(ctx.log.warn).to.have.been.calledWithMatch(/pre-cutoff sites.*kill switch.*Reverted brandalf/);
      });

      it('row 1: still returns v1 even if upsertFeatureFlag fails', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: true,
        });
        // Make upsert fail
        ctx.dataAccess.services.postgrestClient.getUpsertStub().returns({
          select: sinon.stub().returns({
            single: sinon.stub().resolves({ data: null, error: { message: 'upsert failed' } }),
          }),
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
        expect(ctx.log.error).to.have.been.calledWithMatch(/Failed to revert brandalf flag/);
      });

      it('row 3: kill switch + no pre-cutoff + brandalf=true → v2', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.info).to.have.been.calledWithMatch(/brandalf=true.*using v2/);
      });

      it('row 3: kill switch + no sites + brandalf=true → v2', async () => {
        const ctx = makeContext({
          sites: [],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
      });

      it('row 5: default v2 + pre-cutoff + brandalf=true → v2', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.info).to.have.been.calledWithMatch(/brandalf=true.*using v2/);
      });

      it('row 5: does not check pre-cutoff sites when kill switch is off', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          brandalfValue: true,
        });
        await resolveLlmoOnboardingMode('org-1', ctx);
        // Site lookup not called — brandalf=true + no kill switch = v2 immediately
        expect(ctx.dataAccess.Site.allByOrganizationId).not.to.have.been.called;
      });

      it('row 7: default v2 + no pre-cutoff + brandalf=true → v2', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)],
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
      });

      it('falls through to default resolution when brandalf flag read fails', async () => {
        const ctx = makeContext({
          sites: [],
          brandalfValue: 'throw',
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to read brandalf flag/);
      });

      it('row 1: falls through to v2 when hasPreBrandalfSites throws (brandalf=true preserved)', async () => {
        const ctx = makeContext({
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          throwOnLookup: true,
          brandalfValue: true,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        // Cannot confirm pre-cutoff sites → honor brandalf=true → v2
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to check pre-Brandalf sites/);
      });
    });

    // ── Kill switch — no brandalf flag (rows 2, 4) ─────────────────────────

    describe('kill switch — no brandalf flag (rows 2, 4)', () => {
      it('row 2: kill switch + pre-cutoff + no brandalf → v1', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: null,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
      });

      it('row 4: kill switch + no pre-cutoff + no brandalf → v1', async () => {
        const ctx = makeContext({
          sites: [],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: null,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
      });

      it('kill switch skips site lookup when brandalf is false', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
          brandalfValue: false,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
        // brandalf=false → falls to kill switch → v1 without site check
        expect(ctx.dataAccess.Site.allByOrganizationId).not.to.have.been.called;
      });
    });

    // ── Default v2 — no brandalf flag (rows 6, 8) ──────────────────────────

    describe('default v2 — no brandalf flag (rows 6, 8)', () => {
      it('row 6: default v2 + pre-cutoff + no brandalf → v1', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('row 8: default v2 + no pre-cutoff + no brandalf → v2', async () => {
        const ctx = makeContext({ sites: [], brandalfValue: null });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v2 when all sites are at or after the cutoff', async () => {
        const ctx = makeContext({
          sites: [makeSite(AT_CUTOFF), makeSite(AFTER_CUTOFF)],
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v1 when org has multiple sites and at least one predates cutoff', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF), makeSite(BEFORE_CUTOFF)],
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('returns v1 for a legacy org even when LLMO_ONBOARDING_DEFAULT_VERSION = v2', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v2' },
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('returns v2 and falls through when site lookup throws', async () => {
        const ctx = makeContext({ throwOnLookup: true, brandalfValue: null });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to check pre-Brandalf sites/);
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
          sites: [],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'banana' },
          brandalfValue: null,
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWith(
          'Invalid LLMO_ONBOARDING_DEFAULT_VERSION "banana", falling back to v2',
        );
      });

      it('custom cutoff: treats a post-default-cutoff site as legacy', async () => {
        const futureCutoff = new Date('2026-06-01T00:00:00Z').getTime();
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)],
          env: { LLMO_BRANDALF_GA_CUTOFF_MS: String(futureCutoff) },
          brandalfValue: null,
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });
    });
  });
});
