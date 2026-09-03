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
    seed_site_id: 's1',
    blocking_conflicts: [],
    taxonomy: {
      categories_reused: 0,
      categories_copied: 0,
      topics_reused: 0,
      topics_copied: 0,
      org_feature_flags_copied: 0,
    },
    brands: [{
      id: 'b1', name: 'Acme', status: 'active', site_id: 's1',
    }],
    sites: [{ id: 's1', base_url: 'https://acme.com', is_seed: true }],
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
    it('calls rpc_org_move_preview with the seed site and destination org id', async () => {
      rpcStub.resolves({ data: basePreview(), error: null });

      const preview = await previewOrgMove(context, 's1', 'dst-1');

      expect(rpcStub).to.have.been.calledOnceWith('rpc_org_move_preview', {
        p_site_id: 's1',
        p_dst_org: 'dst-1',
      });
      expect(preview.ok).to.be.true;
    });

    it('unwraps a single-element array payload', async () => {
      rpcStub.resolves({ data: [basePreview()], error: null });

      const preview = await previewOrgMove(context, 's1', 'dst-1');

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
    it('calls wrpc_move_brandalf_org with the seed site and the audit stamp', async () => {
      rpcStub.resolves({ data: { ok: true, brands_moved: 3 }, error: null });

      const result = await executeOrgMove(context, 's1', 'dst-1', 'slack:tester');

      expect(rpcStub).to.have.been.calledOnceWith('wrpc_move_brandalf_org', {
        p_site_id: 's1',
        p_dst_org: 'dst-1',
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

    it('explains a missing site', () => {
      expect(describePreviewError({ error: 'site_not_found' }))
        .to.contain('site no longer exists');
    });

    it('explains missing arguments', () => {
      expect(describePreviewError({ error: 'site_and_destination_required' }))
        .to.contain('both required');
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

    it('labels a cross-org brand or site pulled in by the closure', () => {
      const rendered = formatBlockingConflicts([
        { type: 'foreign_brand_in_scope', detail: 'brand-uuid-1' },
        { type: 'foreign_site_in_scope', detail: 'site-uuid-2' },
      ]);

      expect(rendered).to.contain('belongs to a different org');
      expect(rendered).to.contain('brand-uuid-1');
      expect(rendered).to.contain('site-uuid-2');
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

    it('explains that the closure moves as one unit', () => {
      const text = buildPreviewMessage(basePreview(), 'https://acme.com');

      expect(text).to.contain('Everything below moves together');
      expect(text).to.contain('Seeded from site');
    });

    it('marks the site the operator named', () => {
      const text = buildPreviewMessage(basePreview({
        sites: [
          { id: 's1', base_url: 'https://acme.com', is_seed: true },
          { id: 's2', base_url: 'https://acme.co.uk', is_seed: false },
        ],
      }), 'https://acme.com');

      expect(text).to.contain('`https://acme.com` ← _the site you named_');
      expect(text).to.contain('`https://acme.co.uk`\n');
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

    it('describes the taxonomy copy/reuse plan, pluralised', () => {
      const text = buildPreviewMessage(basePreview({
        taxonomy: {
          categories_reused: 2,
          categories_copied: 1,
          topics_reused: 4,
          topics_copied: 3,
          org_feature_flags_copied: 2,
        },
      }), 'https://acme.com');

      expect(text).to.contain('Shared taxonomy');
      expect(text).to.contain('*1* category');
      expect(text).to.contain('*3* topics');
      expect(text).to.contain('*copied* into the destination org');
      expect(text).to.contain('*2* categories');
      expect(text).to.contain('*4* topics');
      expect(text).to.contain('*reused*');
      expect(text).to.contain('The originals stay in the source org');
      expect(text).to.contain('*2* org-level feature flags');
    });

    it('pluralises a single reused topic and a single org flag correctly', () => {
      const text = buildPreviewMessage(basePreview({
        taxonomy: {
          categories_reused: 1,
          categories_copied: 0,
          topics_reused: 1,
          topics_copied: 0,
          org_feature_flags_copied: 1,
        },
      }), 'https://acme.com');

      expect(text).to.contain('*1* category');
      expect(text).to.contain('*1* topic ');
      expect(text).to.contain('*1* org-level feature flag ');
      expect(text).to.not.contain('*copied* into the destination org');
    });

    it('says nothing about taxonomy when there is none to resolve', () => {
      expect(buildPreviewMessage(basePreview(), 'https://acme.com'))
        .to.not.contain('Shared taxonomy');
    });

    it('tolerates a taxonomy block missing individual keys', () => {
      const text = buildPreviewMessage(basePreview({
        taxonomy: { topics_copied: 2, categories_reused: 3 },
      }), 'https://acme.com');

      expect(text).to.contain('*0* categories');
      expect(text).to.contain('*2* topics');
      expect(text).to.contain('*3* categories');
      expect(text).to.contain('*0* topics');
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

    it('handles a preview with no taxonomy block', () => {
      const preview = basePreview();
      delete preview.taxonomy;

      const text = buildPreviewMessage(preview, 'https://acme.com');

      expect(text).to.not.contain('Shared taxonomy');
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
        source: 'src-1',
        destination: 'dst-1',
        brands_moved: 2,
        sites_moved: 3,
        prompts_moved: 40,
        brand_feature_flags_moved: 5,
      }, 'https://acme.com', basePreview());

      expect(text).to.contain('Moved LLMO organization');
      expect(text).to.contain('Brands moved: *2*');
      expect(text).to.contain('Sites moved: *3*');
      expect(text).to.contain('Prompts moved: *40*');
      expect(text).to.contain('Brand feature flags moved: *5*');
      expect(text).to.contain(ENTITLEMENT_GOTCHA);
    });

    it('takes the org display names from the preview, not the result', () => {
      const text = buildResultMessage(
        { source: 'src-1', destination: 'dst-1' },
        'https://acme.com',
        basePreview(),
      );

      expect(text).to.contain('Source Org');
      expect(text).to.contain('SRC@AdobeOrg');
      expect(text).to.contain('Dest Org');
      expect(text).to.not.contain('_unnamed_');
    });

    it('renders unknown orgs when no preview is supplied', () => {
      expect(buildResultMessage({}, 'https://acme.com')).to.contain('_unknown_');
    });

    it('omits the optional lines when nothing else happened', () => {
      const text = buildResultMessage({}, 'https://acme.com', basePreview());

      expect(text).to.not.contain('feature flags');
      expect(text).to.not.contain('Categories resolved');
      expect(text).to.not.contain('Topics');
      expect(text).to.contain('Brands moved: *0*');
      expect(text).to.contain('Sites moved: *0*');
      expect(text).to.contain('Prompts moved: *0*');
    });

    it('reports copied org flags and the resolved taxonomy when present', () => {
      const text = buildResultMessage({
        brands_moved: 1,
        org_feature_flags_copied: 2,
        categories_mapped: 4,
        topics_mapped: 3,
        source_topics_unowned: 7,
      }, 'https://acme.com', basePreview());

      expect(text).to.contain('Org feature flags copied: *2*');
      expect(text).to.contain('Categories resolved in the destination: *4*');
      expect(text).to.contain('Topics resolved in the destination: *3*');
      expect(text).to.contain('released from their moved brand: *7*');
    });
  });
});
