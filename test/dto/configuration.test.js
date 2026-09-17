/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';

import { ConfigurationDto } from '../../src/dto/configuration.js';

describe('ConfigurationDto.versionsToJSON', () => {
  it('maps enriched versions and pagination markers', () => {
    const page = {
      versions: [
        {
          versionId: 'v2',
          lastModified: '2026-07-23T10:00:00.000Z',
          isLatest: true,
          size: 3000,
          updatedBy: 'admin@adobe.com',
          updatedAt: '2026-07-23T10:00:00.000Z',
        },
      ],
      isTruncated: true,
      nextKeyMarker: 'config/spacecat/global-config.json',
      nextVersionIdMarker: 'v1',
    };

    expect(ConfigurationDto.versionsToJSON(page)).to.deep.equal(page);
  });

  it('omits updatedBy/updatedAt when they are absent (detail=false rows)', () => {
    const result = ConfigurationDto.versionsToJSON({
      versions: [{
        versionId: 'v1', lastModified: 'x', isLatest: false, size: 1,
      }],
      isTruncated: false,
      nextKeyMarker: null,
      nextVersionIdMarker: null,
    });

    expect(result.versions[0]).to.not.have.property('updatedBy');
    expect(result.versions[0]).to.not.have.property('updatedAt');
  });

  it('preserves explicit null updatedBy/updatedAt (older versions)', () => {
    const result = ConfigurationDto.versionsToJSON({
      versions: [{
        versionId: 'v1', lastModified: 'x', isLatest: false, size: 1, updatedBy: null, updatedAt: null,
      }],
    });

    expect(result.versions[0].updatedBy).to.be.null;
    expect(result.versions[0].updatedAt).to.be.null;
  });

  it('defaults an empty/absent page to a safe shape', () => {
    const result = ConfigurationDto.versionsToJSON({});
    expect(result).to.deep.equal({
      versions: [],
      isTruncated: false,
      nextKeyMarker: null,
      nextVersionIdMarker: null,
    });
  });
});
