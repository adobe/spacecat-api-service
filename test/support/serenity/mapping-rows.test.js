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

import { expect } from 'chai';
import sinon from 'sinon';

import {
  upsertMappingRow, tombstoneMappingRow, tombstoneAllForBrand, linkSiteToLiveRows,
} from '../../../src/support/serenity/mapping-rows.js';

const BRAND = 'brand-1';
const SLICE = {
  brandId: BRAND, semrushProjectId: 'proj-1', geoTargetId: 2840, languageCode: 'en',
};

function fakeRow({ deletedAt, siteId } = {}) {
  return {
    getDeletedAt: sinon.stub().returns(deletedAt),
    setDeletedAt: sinon.stub(),
    getSiteId: sinon.stub().returns(siteId),
    setSiteId: sinon.stub(),
    save: sinon.stub().resolves(),
  };
}

function slicePartialUniqueError() {
  const err = new Error('Failed to create');
  err.cause = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "uq_brand_to_semrush_slice_live"',
  };
  return err;
}

describe('serenity mapping-rows', () => {
  let log;

  beforeEach(() => {
    log = { warn: sinon.spy(), error: sinon.spy(), info: sinon.spy() };
  });

  afterEach(() => sinon.restore());

  describe('upsertMappingRow', () => {
    it('no-ops when dataAccess has no BrandSemrushProject', async () => {
      await upsertMappingRow({}, SLICE, log);
      await upsertMappingRow(null, SLICE, log);
      await upsertMappingRow(undefined, SLICE, log);
      expect(log.error).to.not.have.been.called;
      expect(log.warn).to.not.have.been.called;
    });

    it('no-ops and warns when the slice is incomplete', async () => {
      const create = sinon.stub();
      const dataAccess = { BrandSemrushProject: { create } };
      await upsertMappingRow(dataAccess, { ...SLICE, brandId: '' }, log);
      await upsertMappingRow(dataAccess, { ...SLICE, semrushProjectId: null }, log);
      await upsertMappingRow(dataAccess, { ...SLICE, languageCode: undefined }, log);
      expect(create).to.not.have.been.called;
      expect(log.warn).to.have.been.calledThrice;
    });

    it('upserts keyed on semrushProjectId, clearing deletedAt (revive), never touching siteId', async () => {
      const create = sinon.stub().resolves({});
      await upsertMappingRow({ BrandSemrushProject: { create } }, SLICE, log);

      expect(create).to.have.been.calledOnce;
      const [payload, options] = create.firstCall.args;
      expect(payload).to.deep.equal({
        brandId: SLICE.brandId,
        semrushProjectId: SLICE.semrushProjectId,
        geoTargetId: SLICE.geoTargetId,
        languageCode: SLICE.languageCode,
        deletedAt: null,
      });
      expect(payload).to.not.have.property('siteId');
      expect(options).to.deep.equal({ upsert: true, onConflict: 'semrushProjectId' });
      expect(log.error).to.not.have.been.called;
    });

    it('classifies a live-slice-index 23505 as an accepted duplicate-slice race (warn, non-alarmed, swallowed)', async () => {
      const create = sinon.stub().rejects(slicePartialUniqueError());
      await upsertMappingRow({ BrandSemrushProject: { create } }, SLICE, log);

      expect(log.error).to.not.have.been.called;
      expect(log.warn).to.have.been.calledOnce;
      const [message] = log.warn.firstCall.args;
      expect(message).to.include('SERENITY_MAPPING_DUPLICATE_SLICE_SKIPPED');
    });

    it('logs the alarmed write-failure token for any other error (fails noisy, not silent)', async () => {
      const create = sinon.stub().rejects(new Error('connection refused'));
      await upsertMappingRow({ BrandSemrushProject: { create } }, SLICE, log);

      expect(log.warn).to.not.have.been.called;
      expect(log.error).to.have.been.calledOnce;
      const [message] = log.error.firstCall.args;
      expect(message).to.include('SERENITY_MAPPING_ROW_WRITE_FAILED');
    });

    it('classifies a 23505 on a different constraint as a real failure (alarmed), not the accepted race', async () => {
      const err = new Error('Failed to create');
      err.cause = { code: '23505', message: 'duplicate key value violates unique constraint "uq_brand_to_semrush_project"' };
      const create = sinon.stub().rejects(err);
      await upsertMappingRow({ BrandSemrushProject: { create } }, SLICE, log);

      expect(log.warn).to.not.have.been.called;
      expect(log.error).to.have.been.calledOnce;
    });

    it('treats a 23505 with no message as a real failure (message fallback branch)', async () => {
      const err = new Error('Failed to create');
      err.cause = { code: '23505' };
      const create = sinon.stub().rejects(err);
      await upsertMappingRow({ BrandSemrushProject: { create } }, SLICE, log);

      expect(log.warn).to.not.have.been.called;
      expect(log.error).to.have.been.calledOnce;
    });
  });

  describe('tombstoneMappingRow', () => {
    it('no-ops when dataAccess has no BrandSemrushProject or semrushProjectId is missing', async () => {
      await tombstoneMappingRow({}, 'proj-1', log);
      await tombstoneMappingRow({ BrandSemrushProject: {} }, '', log);
      expect(log.error).to.not.have.been.called;
    });

    it('is a no-op when no row matches', async () => {
      const findBySemrushProjectId = sinon.stub().resolves(null);
      await tombstoneMappingRow({ BrandSemrushProject: { findBySemrushProjectId } }, 'proj-1', log);
      expect(log.error).to.not.have.been.called;
    });

    it('sets deletedAt and saves the matched row', async () => {
      const row = fakeRow();
      const findBySemrushProjectId = sinon.stub().resolves(row);
      await tombstoneMappingRow({ BrandSemrushProject: { findBySemrushProjectId } }, 'proj-1', log);

      expect(row.setDeletedAt).to.have.been.calledOnce;
      expect(row.setDeletedAt.firstCall.args[0]).to.be.a('string');
      expect(row.save).to.have.been.calledOnce;
    });

    it('logs the alarmed token and swallows a save failure', async () => {
      const row = fakeRow();
      row.save.rejects(new Error('boom'));
      const findBySemrushProjectId = sinon.stub().resolves(row);
      await tombstoneMappingRow({ BrandSemrushProject: { findBySemrushProjectId } }, 'proj-1', log);

      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('SERENITY_MAPPING_ROW_WRITE_FAILED');
    });
  });

  describe('tombstoneAllForBrand', () => {
    it('no-ops when dataAccess has no BrandSemrushProject or brandId is missing', async () => {
      await tombstoneAllForBrand({}, BRAND, log);
      await tombstoneAllForBrand({ BrandSemrushProject: {} }, '', log);
      expect(log.error).to.not.have.been.called;
    });

    it('tombstones only live rows, leaving already-tombstoned rows untouched', async () => {
      const live1 = fakeRow();
      const live2 = fakeRow();
      const alreadyTombstoned = fakeRow({ deletedAt: '2026-06-01T00:00:00.000Z' });
      const allByBrandId = sinon.stub().resolves([live1, alreadyTombstoned, live2]);
      await tombstoneAllForBrand({ BrandSemrushProject: { allByBrandId } }, BRAND, log);

      expect(live1.setDeletedAt).to.have.been.calledOnce;
      expect(live1.save).to.have.been.calledOnce;
      expect(live2.setDeletedAt).to.have.been.calledOnce;
      expect(live2.save).to.have.been.calledOnce;
      expect(alreadyTombstoned.setDeletedAt).to.not.have.been.called;
      expect(alreadyTombstoned.save).to.not.have.been.called;
    });

    it('is a no-op (no throw) when the brand has no rows', async () => {
      const allByBrandId = sinon.stub().resolves([]);
      await tombstoneAllForBrand({ BrandSemrushProject: { allByBrandId } }, BRAND, log);
      expect(log.error).to.not.have.been.called;
    });

    it('logs the alarmed token and swallows a bulk-tombstone failure', async () => {
      const allByBrandId = sinon.stub().rejects(new Error('boom'));
      await tombstoneAllForBrand({ BrandSemrushProject: { allByBrandId } }, BRAND, log);

      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('SERENITY_MAPPING_ROW_WRITE_FAILED');
    });

    it('tolerates a non-array result from allByBrandId (defensive fallback)', async () => {
      const allByBrandId = sinon.stub().resolves(null);
      await tombstoneAllForBrand({ BrandSemrushProject: { allByBrandId } }, BRAND, log);
      expect(log.error).to.not.have.been.called;
    });
  });

  describe('linkSiteToLiveRows', () => {
    const SITE = 'site-1';

    it('no-ops when dataAccess has no BrandSemrushProject, brandId, or siteId is missing', async () => {
      await linkSiteToLiveRows({}, BRAND, SITE, log);
      await linkSiteToLiveRows({ BrandSemrushProject: {} }, '', SITE, log);
      await linkSiteToLiveRows({ BrandSemrushProject: {} }, BRAND, null, log);
      expect(log.error).to.not.have.been.called;
    });

    it('links only live rows with no existing siteId; never overwrites an existing link', async () => {
      const unlinked = fakeRow();
      const alreadyLinked = fakeRow({ siteId: 'site-other' });
      const tombstonedUnlinked = fakeRow({ deletedAt: '2026-06-01T00:00:00.000Z' });
      const allByBrandId = sinon.stub().resolves([unlinked, alreadyLinked, tombstonedUnlinked]);
      await linkSiteToLiveRows({ BrandSemrushProject: { allByBrandId } }, BRAND, SITE, log);

      expect(unlinked.setSiteId).to.have.been.calledOnceWith(SITE);
      expect(unlinked.save).to.have.been.calledOnce;
      expect(alreadyLinked.setSiteId).to.not.have.been.called;
      expect(tombstonedUnlinked.setSiteId).to.not.have.been.called;
    });

    it('logs the alarmed token and swallows a link failure', async () => {
      const allByBrandId = sinon.stub().rejects(new Error('boom'));
      await linkSiteToLiveRows({ BrandSemrushProject: { allByBrandId } }, BRAND, SITE, log);

      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('SERENITY_MAPPING_ROW_WRITE_FAILED');
    });

    it('tolerates a non-array result from allByBrandId (defensive fallback)', async () => {
      const allByBrandId = sinon.stub().resolves(undefined);
      await linkSiteToLiveRows({ BrandSemrushProject: { allByBrandId } }, BRAND, SITE, log);
      expect(log.error).to.not.have.been.called;
    });
  });
});
