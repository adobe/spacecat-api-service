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

import Experiment from '../../../../src/models/experiment/experiment.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('ExperimentModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      experimentId: 'e12345',
      siteId: 'site67890',
      conversionEventName: 'someConversionEventName',
      conversionEventValue: '100',
      endDate: '2024-01-01T00:00:00.000Z',
      expId: 'someExpId',
      name: 'someName',
      startDate: '2024-01-01T00:00:00.000Z',
      status: 'ACTIVE',
      type: 'someType',
      url: 'someUrl',
      updatedBy: 'someUpdatedBy',
      variants: [{ someVariant: 'someVariant' }],
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(Experiment, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the Experiment instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('experimentId', () => {
    it('gets experimentId', () => {
      expect(instance.getId()).to.equal('e12345');
    });
  });

  describe('siteId', () => {
    it('gets siteId', () => {
      expect(instance.getSiteId()).to.equal('site67890');
    });

    it('sets siteId', () => {
      instance.setSiteId('2c1f0868-cc2d-4358-ba26-a7b5965ee403');
      expect(instance.getSiteId()).to.equal('2c1f0868-cc2d-4358-ba26-a7b5965ee403');
    });
  });

  describe('conversionEventName', () => {
    it('gets conversionEventName', () => {
      expect(instance.getConversionEventName()).to.equal('someConversionEventName');
    });

    it('sets conversionEventName', () => {
      instance.setConversionEventName('newConversionEventName');
      expect(instance.getConversionEventName()).to.equal('newConversionEventName');
    });
  });

  describe('conversionEventValue', () => {
    it('gets conversionEventValue', () => {
      expect(instance.getConversionEventValue()).to.equal('100');
    });

    it('sets conversionEventValue', () => {
      instance.setConversionEventValue('200');
      expect(instance.getConversionEventValue()).to.equal('200');
    });
  });

  describe('endDate', () => {
    it('gets endDate', () => {
      expect(instance.getEndDate()).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('sets endDate', () => {
      const newEndDate = '2024-01-02T00:00:00.000Z';
      instance.setEndDate(newEndDate);
      expect(instance.getEndDate()).to.equal(newEndDate);
    });
  });

  describe('expId', () => {
    it('gets expId', () => {
      expect(instance.getExpId()).to.equal('someExpId');
    });

    it('sets expId', () => {
      instance.setExpId('newExpId');
      expect(instance.getExpId()).to.equal('newExpId');
    });
  });

  describe('name', () => {
    it('gets name', () => {
      expect(instance.getName()).to.equal('someName');
    });

    it('sets name', () => {
      instance.setName('newName');
      expect(instance.getName()).to.equal('newName');
    });
  });

  describe('startDate', () => {
    it('gets startDate', () => {
      expect(instance.getStartDate()).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('sets startDate', () => {
      const newStartDate = '2024-01-02T00:00:00.000Z';
      instance.setStartDate(newStartDate);
      expect(instance.getStartDate()).to.equal(newStartDate);
    });
  });

  describe('status', () => {
    it('gets status', () => {
      expect(instance.getStatus()).to.equal('ACTIVE');
    });

    it('sets status', () => {
      instance.setStatus('INACTIVE');
      expect(instance.getStatus()).to.equal('INACTIVE');
    });
  });

  describe('type', () => {
    it('gets type', () => {
      expect(instance.getType()).to.equal('someType');
    });

    it('sets type', () => {
      instance.setType('newType');
      expect(instance.getType()).to.equal('newType');
    });
  });

  describe('url', () => {
    it('gets url', () => {
      expect(instance.getUrl()).to.equal('someUrl');
    });

    it('sets url', () => {
      instance.setUrl('newUrl');
      expect(instance.getUrl()).to.equal('newUrl');
    });
  });

  describe('updatedBy', () => {
    it('gets updatedBy', () => {
      expect(instance.getUpdatedBy()).to.equal('someUpdatedBy');
    });

    it('sets updatedBy', () => {
      instance.setUpdatedBy('newUpdatedBy');
      expect(instance.getUpdatedBy()).to.equal('newUpdatedBy');
    });
  });

  describe('variants', () => {
    it('gets variants', () => {
      expect(instance.getVariants()).to.deep.equal([{ someVariant: 'someVariant' }]);
    });

    it('sets variants', () => {
      instance.setVariants([{ newVariant: 'newVariant' }]);
      expect(instance.getVariants()).to.deep.equal([{ newVariant: 'newVariant' }]);
    });
  });
});
