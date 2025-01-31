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

import BaseModel from '../base/base.model.js';

/**
 * Opportunity - A class representing an Opportunity entity.
 * Provides methods to access and manipulate Opportunity-specific data,
 * such as related suggestions, audit IDs, site IDs, etc.
 *
 * @class Opportunity
 * @extends BaseModel
 */

class Opportunity extends BaseModel {
  static ORIGINS = {
    ESS_OPS: 'ESS_OPS',
    AI: 'AI',
    AUTOMATION: 'AUTOMATION',
  };

  static STATUSES = {
    NEW: 'NEW',
    IN_PROGRESS: 'IN_PROGRESS',
    IGNORED: 'IGNORED',
    RESOLVED: 'RESOLVED',
  };

  /**
   * Adds the given suggestions to this Opportunity. Sets this opportunity as the parent
   * of each suggestion, as such the opportunity ID does not need to be provided.
   *
   * @async
   * @param {Array<Object>} suggestions - An array of suggestion objects to add.
   * @return {Promise<{ createdItems: BaseModel[],
   * errorItems: { item: Object, error: ValidationError }[] }>} - A promise that
   * resolves to an object containing the created suggestion items and any
   * errors that occurred.
   */
  async addSuggestions(suggestions) {
    const childSuggestions = suggestions.map((suggestion) => ({
      ...suggestion,
      [this.idName]: this.getId(),
    }));
    return this.entityRegistry
      .getCollection('SuggestionCollection')
      .createMany(childSuggestions, this);
  }
}

export default Opportunity;
