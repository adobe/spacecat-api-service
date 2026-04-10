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
  normalizeLlmoOnboardingMode,
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

function makeSite(createdAt) {
  return { getCreatedAt: () => createdAt };
}

function makeContext({ sites = [], env = {}, throwOnLookup = false } = {}) {
  return {
    env: { LLMO_BRANDALF_GA_CUTOFF_MS: String(CUTOFF), ...env },
    log: { warn: sinon.stub() },
    dataAccess: {
      Site: {
        allByOrganizationId: throwOnLookup
          ? sinon.stub().rejects(new Error('DB error'))
          : sinon.stub().resolves(sites),
      },
    },
  };
}

describe('llmo-onboarding-mode', () => {
  afterEach(() => sinon.restore());

  // ── normalizeLlmoOnboardingMode ───────────────────────────────────────────

  describe('normalizeLlmoOnboardingMode', () => {
    it('returns v2 for v2', () => expect(normalizeLlmoOnboardingMode('v2')).to.equal('v2'));
    it('returns v1 for v1', () => expect(normalizeLlmoOnboardingMode('v1')).to.equal('v1'));
    it('returns v1 for undefined', () => expect(normalizeLlmoOnboardingMode()).to.equal('v1'));
    it('returns v1 for invalid values', () => expect(normalizeLlmoOnboardingMode('bogus')).to.equal('v1'));
  });

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

    it('returns false for sites with null createdAt', async () => {
      const ctx = makeContext({ sites: [makeSite(null)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
    });

    it('returns false for sites with undefined createdAt', async () => {
      const ctx = makeContext({ sites: [makeSite(undefined)] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
    });

    it('returns false for sites with invalid createdAt string', async () => {
      const ctx = makeContext({ sites: [makeSite('not-a-date')] });
      expect(await hasPreBrandalfSites('org-1', ctx)).to.equal(false);
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

  describe('resolveLlmoOnboardingMode', () => {
    describe('global kill switch (LLMO_ONBOARDING_DEFAULT_VERSION = v1)', () => {
      it('returns v1 immediately without querying the DB', async () => {
        const ctx = makeContext({ env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' } });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
        expect(ctx.dataAccess.Site.allByOrganizationId).not.to.have.been.called;
      });

      it('returns v1 even when org has only post-cutoff sites', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v1');
        expect(ctx.dataAccess.Site.allByOrganizationId).not.to.have.been.called;
      });
    });

    describe('default v2 (LLMO_ONBOARDING_DEFAULT_VERSION unset or v2)', () => {
      it('returns v1 for a legacy org with a pre-cutoff site', async () => {
        const ctx = makeContext({ sites: [makeSite(BEFORE_CUTOFF)] });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('returns v2 for an org with no sites', async () => {
        const ctx = makeContext({ sites: [] });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v2 when all sites are at or after the cutoff', async () => {
        const ctx = makeContext({ sites: [makeSite(AT_CUTOFF), makeSite(AFTER_CUTOFF)] });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v2');
      });

      it('returns v1 when org has multiple sites and at least one predates cutoff', async () => {
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF), makeSite(BEFORE_CUTOFF)],
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('still returns v1 for a legacy org even when LLMO_ONBOARDING_DEFAULT_VERSION = v2', async () => {
        const ctx = makeContext({
          sites: [makeSite(BEFORE_CUTOFF)],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v2' },
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });

      it('returns v2 and falls through when DB lookup throws', async () => {
        const ctx = makeContext({ throwOnLookup: true });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWithMatch(/Failed to check pre-Brandalf sites/);
      });

      it('returns v2 when no context is provided', async () => {
        // no context → can't check sites → falls through to v2
        const mode = await resolveLlmoOnboardingMode('org-1');
        expect(mode).to.equal('v2');
      });
    });

    describe('invalid LLMO_ONBOARDING_DEFAULT_VERSION', () => {
      it('warns and falls back to v2 for an unrecognised value', async () => {
        const ctx = makeContext({
          sites: [],
          env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'banana' },
        });
        const mode = await resolveLlmoOnboardingMode('org-1', ctx);
        expect(mode).to.equal('v2');
        expect(ctx.log.warn).to.have.been.calledWith(
          'Invalid LLMO_ONBOARDING_DEFAULT_VERSION "banana", falling back to v2',
        );
      });
    });

    describe('custom cutoff via env var', () => {
      it('treats a post-default-cutoff site as legacy when cutoff is shifted forward', async () => {
        const futureCutoff = new Date('2026-06-01T00:00:00Z').getTime();
        const ctx = makeContext({
          sites: [makeSite(AFTER_CUTOFF)], // after default cutoff, before custom cutoff
          env: { LLMO_BRANDALF_GA_CUTOFF_MS: String(futureCutoff) },
        });
        expect(await resolveLlmoOnboardingMode('org-1', ctx)).to.equal('v1');
      });
    });
  });
});
