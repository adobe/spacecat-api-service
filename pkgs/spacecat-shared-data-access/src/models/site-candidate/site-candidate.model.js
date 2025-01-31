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
 * SiteCandidate - A class representing an SiteCandidate entity.
 * Provides methods to access and manipulate SiteCandidate-specific data.
 *
 * @class SiteCandidate
 * @extends BaseModel
 */
class SiteCandidate extends BaseModel {
  static DEFAULT_UPDATED_BY = 'spacecat';

  static SITE_CANDIDATE_SOURCES = {
    SPACECAT_SLACK_BOT: 'SPACECAT_SLACK_BOT',
    RUM: 'RUM',
    CDN: 'CDN',
  };

  static SITE_CANDIDATE_STATUS = {
    PENDING: 'PENDING', // site candidate notification sent and waiting for human input
    IGNORED: 'IGNORED', // site candidate discarded: not to be added to star catalogue
    APPROVED: 'APPROVED', // site candidate is added to star catalogue
    ERROR: 'ERROR', // site candidate is discovered
  };

  // add your custom methods or overrides here
}

export default SiteCandidate;
