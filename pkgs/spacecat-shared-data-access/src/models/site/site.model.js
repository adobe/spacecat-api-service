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

import { composeAuditURL, hasText, isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseModel from '../base/base.model.js';

/**
 * A class representing a Site entity. Provides methods to access and manipulate Site-specific data.
 * @class Site
 * @extends BaseModel
 */
class Site extends BaseModel {
  static DELIVERY_TYPES = {
    AEM_CS: 'aem_cs',
    AEM_EDGE: 'aem_edge',
    AEM_AMS: 'aem_ams',
    OTHER: 'other',
  };

  static DEFAULT_DELIVERY_TYPE = Site.DELIVERY_TYPES.AEM_EDGE;

  async toggleLive() {
    const newIsLive = !this.getIsLive();
    this.setIsLive(newIsLive);
    return this;
  }

  /**
   * Resolves the site's base URL to a  final URL by fetching the URL,
   * following the redirects and returning the final URL.
   *
   * If the site has a configured overrideBaseURL, that one will be returned.
   * Otherwise, the site's base URL will be used.
   *
   * If the site has a configured User-Agent, it will be used to resolve the URL.
   *
   * @returns a promise that resolves the final URL.
   * @throws {Error} if the final URL cannot be resolved.
   */
  async resolveFinalURL() {
    const overrideBaseURL = this.getConfig()?.getFetchConfig()?.overrideBaseURL;
    if (isValidUrl(overrideBaseURL)) {
      return overrideBaseURL.replace(/^https?:\/\//, '');
    }

    const userAgentConfigured = this.getConfig()?.getFetchConfig()?.headers?.['User-Agent'];
    if (hasText(userAgentConfigured)) {
      return composeAuditURL(this.getBaseURL(), userAgentConfigured);
    }

    return composeAuditURL(this.getBaseURL());
  }
}

export default Site;
