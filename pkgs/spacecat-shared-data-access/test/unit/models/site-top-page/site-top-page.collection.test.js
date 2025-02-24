/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { stub } from 'sinon';
import sinonChai from 'sinon-chai';

import SiteTopPage from '../../../../src/models/site-top-page/site-top-page.model.js';

import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('SiteTopPageCollection', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockLogger;
  let model;
  let schema;

  const mockRecord = {
    siteTopPageId: '11111111-2222-1ccc-8ddd-333333333333',
  };

  beforeEach(() => {
    ({
      mockElectroService,
      mockEntityRegistry,
      mockLogger,
      collection: instance,
      model,
      schema,
    } = createElectroMocks(SiteTopPage, mockRecord));
  });

  describe('constructor', () => {
    it('initializes the SiteTopPageCollection instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.electroService).to.equal(mockElectroService);
      expect(instance.entityRegistry).to.equal(mockEntityRegistry);
      expect(instance.schema).to.equal(schema);
      expect(instance.log).to.equal(mockLogger);

      expect(model).to.be.an('object');
    });
  });

  describe('removeForSiteId', () => {
    it('throws an error if siteId is not provided', async () => {
      await expect(instance.removeForSiteId()).to.be.rejectedWith('SiteId is required');
    });

    it('removes all SiteTopPages for a given siteId', async () => {
      const siteId = '11111111-2222-1ccc-8ddd-333333333333';

      instance.allBySiteId = stub().resolves([model]);

      await instance.removeForSiteId(siteId);

      expect(instance.allBySiteId.calledOnceWith(siteId)).to.be.true;
      expect(mockElectroService.entities.siteTopPage.delete.calledOnceWith([{ siteTopPageId: '11111111-2222-1ccc-8ddd-333333333333' }]))
        .to.be.true;
    });

    it('does not call remove when there are no SiteTopPages for a given siteId', async () => {
      const siteId = '11111111-2222-1ccc-8ddd-333333333333';

      instance.allBySiteId = stub().resolves([]);

      await instance.removeForSiteId(siteId);

      expect(instance.allBySiteId.calledOnceWith(siteId)).to.be.true;
      expect(mockElectroService.entities.siteTopPage.delete).to.not.have.been.called;
    });

    it('remove all SiteTopPages for a given siteId, source and geo', async () => {
      const siteId = '11111111-2222-1ccc-8ddd-333333333333';
      const source = 'ahrefs';
      const geo = 'global';

      instance.allBySiteIdAndSourceAndGeo = stub().resolves([model]);

      await instance.removeForSiteId(siteId, source, geo);

      expect(instance.allBySiteIdAndSourceAndGeo).to.have.been.calledOnceWith(siteId, source, geo);
      expect(mockElectroService.entities.siteTopPage.delete).to.have.been.calledOnceWith([{ siteTopPageId: '11111111-2222-1ccc-8ddd-333333333333' }]);
    });
  });
});
