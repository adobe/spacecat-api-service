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
  ENTITLEMENT_GOTCHA,
  buildPreviewMessage,
  buildResultMessage,
  describePreviewError,
  executeOrgMove,
  formatBlockingConflicts,
  isLargeMove,
  previewOrgMove,
} from '../../../src/support/slack/llmo-org-move.js';

use(chaiAsPromised);
use(sinonChai);

describe('llmo-org-move', () => {
  let sandbox;
  let rpcStub;
  let context;

  /**
   * A minimal, conflict-free preview. Individual tests override just the field
   * they exercise.
   */
  const basePreview = (overrides = {}) => ({
    ok: true,
    source: { id: 'src-1', name: 'Source Org', ims_org_id: 'SRC@AdobeOrg' },
    destination: { id: 'dst-1', name: 'Dest Org', ims_org_id: 'DST@AdobeOrg' },
    blocking_conflicts: [],
    auto_resolved: {
      categories_merged: 0,
      topics_disambiguated: 0,
      feature_flags_dropped: 0,
    },
    brands: [{
      id: 'b1', name: 'Acme', status: 'active', site_id: 's1',
    }],
    sites: [{ id: 's1', base_url: 'https://acme.com' }],
    counts: { brands: 1, prompts: 12, sites: 1 },
    ...overrides,
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    rpcStub = sandbox.stub();
    context = {
      dataAccess: { services: { postgrestClient: { rpc: rpcStub } } },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('previewOrgMove', () => {
    it('calls rpc_org_move_preview with the source and destination org ids', async () => {
      rpcStub.resolves({ data: basePreview(), error: null });

      const preview = await previewOrgMove(context, 'src-1', 'dst-1');

      expect(rpcStub).to.have.been.calledOnceWith('rpc_org_move_preview', {
        p_src: 'src-1',
        p_dst: 'dst-1',
      });
      expect(preview.ok).to.be.true;
    });

    it('unwraps a single-element array payload', async () => {
      rpcStub.resolves({ data: [basePreview()], error: null });

      const preview = await previewOrgMove(context, 'src-1', 'dst-1');

      expect(preview.source.id).to.equal('src-1');
    });

    it('throws when the PostgREST client is unavailable', async () => {
      await expect(previewOrgMove({ dataAccess: {} }, 'a', 'b'))
        .to.be.rejectedWith(/PostgREST client is unavailable/);
    });

    it('throws when the RPC reports an error', async () => {
      rpcStub.resolves({ data: null, error: { message: 'boom' } });

      await expect(previewOrgMove(context, 'a', 'b'))
        .to.be.rejectedWith(/rpc_org_move_preview: boom/);
    });

    it('throws when the RPC returns no data', async () => {
      rpcStub.resolves({ data: [], error: null });

      await expect(previewOrgMove(context, 'a', 'b'))
        .to.be.rejectedWith(/returned no data/);
    });
  });

  describe('executeOrgMove', () => {
    it('calls wrpc_move_brandalf_org with the audit stamp', async () => {
      rpcStub.resolves({ data: { ok: true, brands_moved: 3 }, error: null });

      const result = await executeOrgMove(context, 'src-1', 'dst-1', 'slack:tester');

      expect(rpcStub).to.have.been.calledOnceWith('wrpc_move_brandalf_org', {
        p_src: 'src-1',
        p_dst: 'dst-1',
        p_updated_by: 'slack:tester',
      });
      expect(result.brands_moved).to.equal(3);
    });

    it('throws when the PostgREST client is unavailable', async () => {
      await expect(executeOrgMove({}, 'a', 'b', 'x'))
        .to.be.rejectedWith(/PostgREST client is unavailable/);
    });

    it('throws when the RPC reports an error', async () => {
      rpcStub.resolves({ data: null, error: { message: 'conflict' } });

      await expect(executeOrgMove(context, 'a', 'b', 'x'))
        .to.be.rejectedWith(/wrpc_move_brandalf_org: conflict/);
    });

    it('throws when the RPC returns no data', async () => {
      rpcStub.resolves({ data: null, error: null });

      await expect(executeOrgMove(context, 'a', 'b', 'x'))
        .to.be.rejectedWith(/returned no data/);
    });
  });

  describe('describePreviewError', () => {
    it('returns null when the preview was evaluable', () => {
      expect(describePreviewError(basePreview())).to.be.null;
    });

    it('explains a missing source org', () => {
      expect(describePreviewError({ error: 'source_org_not_found' }))
        .to.contain('current organization no longer exists');
    });

    it('explains a missing destination org', () => {
      expect(describePreviewError({ error: 'destination_org_not_found' }))
        .to.contain('destination organization could not be found');
    });

    it('explains a same-org no-op', () => {
      expect(describePreviewError({ error: 'same_org' }))
        .to.contain('already in that organization');
    });

    it('falls back to the raw code for an unrecognised error', () => {
      expect(describePreviewError({ error: 'something_new' }))
        .to.contain('something_new');
    });
  });

  describe('isLargeMove', () => {
    it('is false for a small move', () => {
      expect(isLargeMove(basePreview())).to.be.false;
    });

    it('is true when the site count exceeds the threshold', () => {
      const sites = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, base_url: `https://s${i}.com` }));
      expect(isLargeMove(basePreview({ sites }))).to.be.true;
    });

    it('is true when the active brand count exceeds the threshold', () => {
      const brands = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, status: 'active' }));
      expect(isLargeMove(basePreview({ brands }))).to.be.true;
    });

    it('ignores inactive brands when counting', () => {
      const brands = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, status: 'archived' }));
      expect(isLargeMove(basePreview({ brands }))).to.be.false;
    });

    it('handles a preview with no brands or sites', () => {
      expect(isLargeMove({})).to.be.false;
    });
  });

  describe('formatBlockingConflicts', () => {
    it('renders the {type, detail} object shape with a friendly label', () => {
      const rendered = formatBlockingConflicts([
        { type: 'brand_name', detail: 'Acme' },
        { type: 'brand_base_site', detail: 'site-uuid-1' },
      ]);

      expect(rendered).to.contain('already exists in the destination org');
      expect(rendered).to.contain('Acme');
      expect(rendered).to.contain('already uses this site');
      expect(rendered).to.contain('site-uuid-1');
    });

    it('falls back to the raw type for an unknown conflict', () => {
      expect(formatBlockingConflicts([{ type: 'future_kind', detail: 'x' }]))
        .to.contain('future_kind');
    });

    it('renders an empty string for no conflicts', () => {
      expect(formatBlockingConflicts()).to.equal('');
    });
  });

  describe('buildPreviewMessage', () => {
    it('reports the orgs, counts, brands and sites', () => {
      const text = buildPreviewMessage(basePreview(), 'https://acme.com');

      expect(text).to.contain('Source Org');
      expect(text).to.contain('SRC@AdobeOrg');
      expect(text).to.contain('Dest Org');
      expect(text).to.contain('Prompts: *12*');
      expect(text).to.contain('Acme');
      expect(text).to.contain('https://acme.com');
    });

    it('always carries the entitlement gotcha', () => {
      expect(buildPreviewMessage(basePreview(), 'https://acme.com'))
        .to.contain(ENTITLEMENT_GOTCHA);
    });

    it('omits tables with a zero count', () => {
      const text = buildPreviewMessage(basePreview({ counts: { brands: 1 } }), 'https://acme.com');
      expect(text).to.not.contain('Prompts:');
    });

    it('reports when there is nothing to move', () => {
      const text = buildPreviewMessage(
        basePreview({ counts: {}, brands: [], sites: [] }),
        'https://acme.com',
      );
      expect(text).to.contain('Nothing to move');
      expect(text).to.contain('No brands');
      expect(text).to.contain('No sites');
    });

    it('flags a brand with no site', () => {
      const text = buildPreviewMessage(
        basePreview({
          brands: [{
            id: 'b1', name: 'Acme', status: 'inactive', site_id: null,
          }],
        }),
        'https://acme.com',
      );
      expect(text).to.contain('no site');
    });

    it('lists auto-resolved conflicts, pluralised', () => {
      const text = buildPreviewMessage(basePreview({
        auto_resolved: {
          categories_merged: 1,
          topics_disambiguated: 2,
          feature_flags_dropped: 3,
        },
      }), 'https://acme.com');

      expect(text).to.contain('Automatically resolved conflicts');
      expect(text).to.contain('*1* category');
      expect(text).to.contain('*2* topic ids');
      expect(text).to.contain('*3* duplicate feature flags');
    });

    it('pluralises a single topic and flag correctly', () => {
      const text = buildPreviewMessage(basePreview({
        auto_resolved: {
          categories_merged: 2,
          topics_disambiguated: 1,
          feature_flags_dropped: 1,
        },
      }), 'https://acme.com');

      expect(text).to.contain('*2* categories');
      expect(text).to.contain('*1* topic id ');
      expect(text).to.contain('*1* duplicate feature flag ');
    });

    it('shouts about an unusually large move', () => {
      const sites = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, base_url: `https://s${i}.com` }));
      const text = buildPreviewMessage(basePreview({ sites }), 'https://acme.com');

      expect(text).to.contain('unusually large move');
      expect(text).to.contain('7 sites');
    });

    it('reports a large brand-driven move even when the site list is absent', () => {
      const brands = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, status: 'active' }));
      const preview = basePreview({ brands });
      delete preview.sites;

      const text = buildPreviewMessage(preview, 'https://acme.com');

      expect(text).to.contain('unusually large move');
      expect(text).to.contain('0 sites');
      expect(text).to.contain('6 active brands');
    });

    it('handles a preview with no auto_resolved block', () => {
      const preview = basePreview();
      delete preview.auto_resolved;

      const text = buildPreviewMessage(preview, 'https://acme.com');

      expect(text).to.not.contain('Automatically resolved conflicts');
    });

    it('reports a large site-driven move even when the brand list is absent', () => {
      const sites = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, base_url: `https://s${i}.com` }));
      const preview = basePreview({ sites });
      delete preview.brands;

      const text = buildPreviewMessage(preview, 'https://acme.com');

      expect(text).to.contain('unusually large move');
      expect(text).to.contain('6 sites');
      expect(text).to.contain('0 active brands');
    });

    it('renders an org with no ims org id or name', () => {
      const text = buildPreviewMessage(
        basePreview({ source: { id: 'x' }, destination: null }),
        'https://acme.com',
      );
      expect(text).to.contain('_unnamed_');
      expect(text).to.contain('_unknown_');
    });
  });

  describe('buildResultMessage', () => {
    it('summarises a clean move', () => {
      const text = buildResultMessage({
        source: { id: 'src-1', name: 'Source Org', ims_org_id: 'SRC@AdobeOrg' },
        destination: { id: 'dst-1', name: 'Dest Org', ims_org_id: 'DST@AdobeOrg' },
        brands_moved: 2,
        feature_flags_moved: 5,
      }, 'https://acme.com');

      expect(text).to.contain('Moved LLMO organization');
      expect(text).to.contain('Brands moved: *2*');
      expect(text).to.contain('Feature flags moved: *5*');
      expect(text).to.contain(ENTITLEMENT_GOTCHA);
    });

    it('omits conflict lines when nothing was auto-resolved', () => {
      const text = buildResultMessage({}, 'https://acme.com');

      expect(text).to.not.contain('merged');
      expect(text).to.not.contain('renamed');
      expect(text).to.not.contain('dropped');
      expect(text).to.contain('Brands moved: *0*');
      expect(text).to.contain('Feature flags moved: *0*');
    });

    it('reports auto-resolved conflicts when present', () => {
      const text = buildResultMessage({
        brands_moved: 1,
        feature_flags_moved: 1,
        categories_merged: 4,
        topics_disambiguated: 3,
        feature_flags_dropped: 2,
      }, 'https://acme.com');

      expect(text).to.contain('Categories merged into existing destination rows: *4*');
      expect(text).to.contain('Topics renamed to avoid a clash: *3*');
      expect(text).to.contain('Duplicate feature flags dropped: *2*');
    });
  });
});
