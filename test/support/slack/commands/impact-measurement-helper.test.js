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

import { resolveGeoExperiment } from '../../../../src/support/slack/commands/impact-measurement-helper.js';

use(sinonChai);

const VALID_GEO_EXP_ID = '11111111-1111-4111-8111-111111111111';

function mockGeoExperiment({ id = 'geo-exp-1', siteId = 'site-1' } = {}) {
  return {
    getId: () => id,
    getSiteId: () => siteId,
  };
}

describe('resolveGeoExperiment', () => {
  let GeoExperiment;
  const site = { getId: () => 'site-1' };
  const baseURL = 'https://example.com';

  beforeEach(() => {
    GeoExperiment = {
      allBySiteId: sinon.stub(),
      findById: sinon.stub(),
    };
  });

  describe('without an explicit geoExperimentId', () => {
    it('returns the most recently updated experiment', async () => {
      const latest = mockGeoExperiment({ id: 'geo-exp-latest' });
      const older = mockGeoExperiment({ id: 'geo-exp-older' });
      GeoExperiment.allBySiteId.resolves({ data: [latest, older] });

      const result = await resolveGeoExperiment({ GeoExperiment, site, baseURL });

      expect(result.geoExperiment).to.equal(latest);
      expect(result.errorMessage).to.be.undefined;
      expect(GeoExperiment.findById).to.not.have.been.called;
    });

    it('returns an error message when there are no experiments', async () => {
      GeoExperiment.allBySiteId.resolves({ data: [] });

      const result = await resolveGeoExperiment({ GeoExperiment, site, baseURL });

      expect(result.geoExperiment).to.be.undefined;
      expect(result.errorMessage).to.include('No geo-experiments found');
    });
  });

  describe('with an explicit geoExperimentId', () => {
    it('returns the experiment when it exists and belongs to the site', async () => {
      const geo = mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-1' });
      GeoExperiment.findById.resolves(geo);

      const result = await resolveGeoExperiment({
        GeoExperiment, site, baseURL, geoExperimentIdInput: VALID_GEO_EXP_ID,
      });

      expect(result.geoExperiment).to.equal(geo);
      expect(result.errorMessage).to.be.undefined;
      expect(GeoExperiment.allBySiteId).to.not.have.been.called;
    });

    it('returns an error message for an invalid id', async () => {
      const result = await resolveGeoExperiment({
        GeoExperiment, site, baseURL, geoExperimentIdInput: 'not-a-uuid',
      });

      expect(result.errorMessage).to.include('not a valid geo-experiment id');
      expect(GeoExperiment.findById).to.not.have.been.called;
    });

    it('returns an error message when the experiment is not found', async () => {
      GeoExperiment.findById.resolves(null);

      const result = await resolveGeoExperiment({
        GeoExperiment, site, baseURL, geoExperimentIdInput: VALID_GEO_EXP_ID,
      });

      expect(result.errorMessage).to.include('No geo-experiment found with id');
    });

    it('returns an error message when the experiment belongs to another site', async () => {
      GeoExperiment.findById.resolves(
        mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-2' }),
      );

      const result = await resolveGeoExperiment({
        GeoExperiment, site, baseURL, geoExperimentIdInput: VALID_GEO_EXP_ID,
      });

      expect(result.errorMessage).to.include('does not belong to');
    });
  });
});
