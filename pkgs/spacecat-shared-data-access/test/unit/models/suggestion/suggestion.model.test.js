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

import Suggestion from '../../../../src/models/suggestion/suggestion.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('SuggestionModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      suggestionId: 'sug12345',
      opportunityId: 'op67890',
      type: 'CODE_CHANGE',
      status: 'NEW',
      rank: 1,
      data: {
        info: 'sample data',
      },
      kpiDeltas: {
        conversionRate: 0.05,
      },
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(Suggestion, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the Suggestion instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('getOpportunityId and setOpportunityId', () => {
    it('returns the Opportunity ID of the suggestion', () => {
      expect(instance.getOpportunityId()).to.equal('op67890');
    });

    it('sets the Opportunity ID of the suggestion', () => {
      instance.setOpportunityId('ef39921f-9a02-41db-b491-02c98987d956');
      expect(instance.record.opportunityId).to.equal('ef39921f-9a02-41db-b491-02c98987d956');
    });
  });

  describe('getType', () => {
    it('returns the type of the suggestion', () => {
      expect(instance.getType()).to.equal('CODE_CHANGE');
    });
  });

  describe('getStatus and setStatus', () => {
    it('returns the status of the suggestion', () => {
      expect(instance.getStatus()).to.equal('NEW');
    });

    it('sets the status of the suggestion', () => {
      instance.setStatus('APPROVED');
      expect(instance.record.status).to.equal('APPROVED');
    });

    it('sets the status of the suggestion to OUTDATED', () => {
      instance.setStatus('OUTDATED');
      expect(instance.record.status).to.equal('OUTDATED');
    });
  });

  describe('getRank and setRank', () => {
    it('returns the rank of the suggestion', () => {
      expect(instance.getRank()).to.equal(1);
    });

    it('sets the rank of the suggestion', () => {
      instance.setRank(5);
      expect(instance.record.rank).to.equal(5);
    });
  });

  describe('getData and setData', () => {
    it('returns additional data for the suggestion', () => {
      expect(instance.getData()).to.deep.equal({ info: 'sample data' });
    });

    it('sets additional data for the suggestion', () => {
      instance.setData({ newInfo: 'updated data' });
      expect(instance.record.data).to.deep.equal({ newInfo: 'updated data' });
    });
  });

  describe('getKpiDeltas and setKpiDeltas', () => {
    it('returns the KPI deltas for the suggestion', () => {
      expect(instance.getKpiDeltas()).to.deep.equal({ conversionRate: 0.05 });
    });

    it('sets the KPI deltas for the suggestion', () => {
      instance.setKpiDeltas({ conversionRate: 0.1 });
      expect(instance.record.kpiDeltas).to.deep.equal({ conversionRate: 0.1 });
    });
  });
});
