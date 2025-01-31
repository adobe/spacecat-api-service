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

import KeyEvent from '../../../../src/models/key-event/key-event.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('KeyEventModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      keyEventId: 'k12345',
      siteId: 's12345',
      name: 'someName',
      type: 'CONTENT',
      time: '2022-01-01T00:00:00.000Z',
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(KeyEvent, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the KeyEvent instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('keyEventId', () => {
    it('gets keyEventId', () => {
      expect(instance.getId()).to.equal('k12345');
    });
  });

  describe('siteId', () => {
    it('gets siteId', () => {
      expect(instance.getSiteId()).to.equal('s12345');
    });

    it('sets siteId', () => {
      instance.setSiteId('51f2eab9-2cd8-47a0-acd0-a2b00d916792');
      expect(instance.getSiteId()).to.equal('51f2eab9-2cd8-47a0-acd0-a2b00d916792');
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

  describe('type', () => {
    it('gets type', () => {
      expect(instance.getType()).to.equal('CONTENT');
    });

    it('sets type', () => {
      instance.setType('STATUS CHANGE');
      expect(instance.getType()).to.equal('STATUS CHANGE');
    });
  });

  describe('time', () => {
    it('gets time', () => {
      expect(instance.getTime()).to.equal('2022-01-01T00:00:00.000Z');
    });

    it('sets time', () => {
      const newTime = '2023-01-01T00:00:00.000Z';
      instance.setTime(newTime);
      expect(instance.getTime()).to.equal(newTime);
    });
  });
});
