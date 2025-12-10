/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable */
/* eslint-env mocha */
/* eslint-disable max-classes-per-file */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import MapperRegistry from '../../src/mappers/mapper-registry.js';
import HeadingsMapper from '../../src/mappers/headings-mapper.js';
import BaseOpportunityMapper from '../../src/mappers/base-mapper.js';

use(sinonChai);

describe('MapperRegistry', () => {
  let registry;
  let log;

  beforeEach(() => {
    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };

    registry = new MapperRegistry(log);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should create an instance and register default mappers', () => {
      expect(registry).to.be.instanceOf(MapperRegistry);
      expect(registry.mappers).to.be.instanceOf(Map);
      expect(registry.mappers.size).to.be.greaterThan(0);
    });
  });

  describe('registerMapper', () => {
    it('should register a custom mapper', () => {
      class CustomMapper extends BaseOpportunityMapper {
        // eslint-disable-next-line class-methods-use-this
        getOpportunityType() {
          return 'custom';
        }

        // eslint-disable-next-line class-methods-use-this
        requiresPrerender() {
          return false;
        }

        // eslint-disable-next-line class-methods-use-this
        suggestionToPatch() {
          return {};
        }

        // eslint-disable-next-line class-methods-use-this
        validateSuggestionData() {
          return true;
        }
      }

      registry.registerMapper(new CustomMapper(log));

      expect(registry.mappers.has('custom')).to.be.true;
      expect(registry.getSupportedOpportunityTypes()).to.include('custom');
    });

    it('should log debug message when overriding existing mapper', () => {
      class CustomMapper extends BaseOpportunityMapper {
        // eslint-disable-next-line class-methods-use-this
        getOpportunityType() {
          return 'headings'; // Override existing headings mapper
        }

        // eslint-disable-next-line class-methods-use-this
        requiresPrerender() {
          return false;
        }

        // eslint-disable-next-line class-methods-use-this
        suggestionToPatch() {
          return {};
        }
      }

      registry.registerMapper(new CustomMapper(log));

      expect(log.debug).to.have.been.calledWith(
        'Mapper for opportunity type "headings" is being overridden',
      );
      expect(log.info).to.have.been.calledWith(
        'Registered mapper for opportunity type: headings',
      );
    });
  });

  describe('getMapper', () => {
    it('should return headings mapper for headings opportunity type', () => {
      const mapper = registry.getMapper('headings');

      expect(mapper).to.be.instanceOf(HeadingsMapper);
    });

    it('should return null for unsupported opportunity type', () => {
      const mapper = registry.getMapper('unsupported-type');

      expect(mapper).to.be.null;
      expect(log.warn).to.have.been.calledWith(
        'No mapper found for opportunity type: unsupported-type',
      );
    });

    it('should return null when opportunity type is empty', () => {
      const mapper = registry.getMapper('');

      expect(mapper).to.be.null;
    });

    it('should return null when opportunity type is null', () => {
      const mapper = registry.getMapper(null);

      expect(mapper).to.be.null;
    });
  });

  describe('getSupportedOpportunityTypes', () => {
    it('should return list of supported opportunity types', () => {
      const types = registry.getSupportedOpportunityTypes();

      expect(types).to.be.an('array');
      expect(types).to.include('headings');
    });

    it('should include custom registered mappers', () => {
      class CustomMapper extends BaseOpportunityMapper {
        // eslint-disable-next-line class-methods-use-this
        getOpportunityType() {
          return 'custom';
        }

        // eslint-disable-next-line class-methods-use-this
        requiresPrerender() {
          return false;
        }

        // eslint-disable-next-line class-methods-use-this
        suggestionToPatch() {
          return {};
        }

        // eslint-disable-next-line class-methods-use-this
        validateSuggestionData() {
          return true;
        }
      }

      registry.registerMapper(new CustomMapper(log));

      const types = registry.getSupportedOpportunityTypes();

      expect(types).to.include('custom');
      expect(types).to.include('headings');
    });
  });

  describe('hasMapper', () => {
    it('should return true for supported opportunity type', () => {
      expect(registry.hasMapper('headings')).to.be.true;
    });

    it('should return false for unsupported opportunity type', () => {
      expect(registry.hasMapper('unsupported')).to.be.false;
    });

    it('should return false for null opportunity type', () => {
      expect(registry.hasMapper(null)).to.be.false;
    });

    it('should return false for undefined opportunity type', () => {
      expect(registry.hasMapper(undefined)).to.be.false;
    });
  });
});
