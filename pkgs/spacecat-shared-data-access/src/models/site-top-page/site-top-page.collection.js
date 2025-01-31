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

import { hasText, isNonEmptyArray } from '@adobe/spacecat-shared-utils';

import BaseCollection from '../base/base.collection.js';

/**
 * SiteTopPageCollection - A collection class responsible for managing SiteTopPage entities.
 * Extends the BaseCollection to provide specific methods for interacting with SiteTopPage records.
 *
 * @class SiteTopPageCollection
 * @extends BaseCollection
 */
class SiteTopPageCollection extends BaseCollection {
  async removeForSiteId(siteId, source, geo) {
    if (!hasText(siteId)) {
      throw new Error('SiteId is required');
    }

    let topPagesToRemove;

    if (hasText(source) && hasText(geo)) {
      topPagesToRemove = await this.allBySiteIdAndSourceAndGeo(siteId, source, geo);
    } else {
      topPagesToRemove = await this.allBySiteId(siteId);
    }

    const topPageIdsToRemove = topPagesToRemove.map((topPage) => topPage.getId());

    if (isNonEmptyArray(topPageIdsToRemove)) {
      await this.removeByIds(topPageIdsToRemove);
    }
  }
}

export default SiteTopPageCollection;
