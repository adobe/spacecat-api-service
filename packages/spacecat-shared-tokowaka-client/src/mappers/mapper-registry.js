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

import HeadingsMapper from './headings-mapper.js';
import ContentSummarizationMapper from './content-summarization-mapper.js';
import FaqMapper from './faq-mapper.js';
import ReadabilityMapper from './readability-mapper.js';
import TocMapper from './toc-mapper.js';
import GenericMapper from './generic-mapper.js';

/**
 * Registry for opportunity mappers
 * Implements Factory Pattern to get the appropriate mapper for an opportunity type
 */
export default class MapperRegistry {
  constructor(log) {
    this.log = log;
    this.mappers = new Map();
    this.#registerDefaultMappers();
  }

  /**
   * Registers default mappers for built-in opportunity types
   * @private
   */
  #registerDefaultMappers() {
    const defaultMappers = [
      HeadingsMapper,
      ContentSummarizationMapper,
      FaqMapper,
      ReadabilityMapper,
      TocMapper,
      GenericMapper,
      // more mappers here
    ];

    defaultMappers.forEach((MapperClass) => {
      const mapper = new MapperClass(this.log);
      this.registerMapper(mapper);
    });
  }

  /**
   * Registers a mapper for an opportunity type
   * @param {BaseOpportunityMapper} mapper - Mapper instance
   */
  registerMapper(mapper) {
    const opportunityType = mapper.getOpportunityType();
    if (this.mappers.has(opportunityType)) {
      this.log.debug(`Mapper for opportunity type "${opportunityType}" is being overridden`);
    }
    this.mappers.set(opportunityType, mapper);
    this.log.info(`Registered mapper for opportunity type: ${opportunityType}`);
  }

  /**
   * Gets mapper for an opportunity type
   * @param {string} opportunityType - Type of opportunity
   * @returns {BaseOpportunityMapper|null} - Mapper instance or null if not found
   */
  getMapper(opportunityType) {
    const mapper = this.mappers.get(opportunityType);
    if (!mapper) {
      this.log.warn(`No mapper found for opportunity type: ${opportunityType}`);
      return null;
    }
    return mapper;
  }

  /**
   * Checks if a mapper exists for an opportunity type
   * @param {string} opportunityType - Type of opportunity
   * @returns {boolean} - True if mapper exists
   */
  hasMapper(opportunityType) {
    return this.mappers.has(opportunityType);
  }

  /**
   * Gets all registered opportunity types
   * @returns {string[]} - Array of opportunity types
   */
  getSupportedOpportunityTypes() {
    return Array.from(this.mappers.keys());
  }
}
