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

import { expect } from 'chai';
import {
  normalizePath,
  getHostName,
  base64UrlEncode,
  getTokowakaConfigS3Path,
  getTokowakaMetaconfigS3Path,
} from '../../src/utils/s3-utils.js';

describe('S3 Utils', () => {
  describe('normalizePath', () => {
    it('should add leading slash if missing', () => {
      const result = normalizePath('page1');
      expect(result).to.equal('/page1');
    });

    it('should keep single slash', () => {
      const result = normalizePath('/');
      expect(result).to.equal('/');
    });

    it('should remove trailing slash except for root', () => {
      const result = normalizePath('/page1/');
      expect(result).to.equal('/page1');
    });

    it('should handle path with leading slash', () => {
      const result = normalizePath('/page1');
      expect(result).to.equal('/page1');
    });
  });

  describe('getHostName', () => {
    it('should extract hostname and remove www', () => {
      const url = new URL('https://www.example.com/page');
      const logger = { error: () => {} };
      const result = getHostName(url, logger);
      expect(result).to.equal('example.com');
    });

    it('should handle hostname without www', () => {
      const url = new URL('https://example.com/page');
      const logger = { error: () => {} };
      const result = getHostName(url, logger);
      expect(result).to.equal('example.com');
    });

    it('should throw error on invalid URL', () => {
      const logger = { error: () => {} };
      const invalidUrl = { hostname: null };

      try {
        getHostName(invalidUrl, logger);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Error extracting host name');
      }
    });
  });

  describe('getTokowakaConfigS3Path', () => {
    const logger = { error: () => {} };

    it('should generate correct S3 path for deploy', () => {
      const url = 'https://example.com/page1';
      const result = getTokowakaConfigS3Path(url, logger, false);
      expect(result).to.equal('opportunities/example.com/L3BhZ2Ux');
    });

    it('should generate correct S3 path for preview', () => {
      const url = 'https://example.com/page1';
      const result = getTokowakaConfigS3Path(url, logger, true);
      expect(result).to.equal('preview/opportunities/example.com/L3BhZ2Ux');
    });

    it('should throw error on invalid URL', () => {
      try {
        getTokowakaConfigS3Path('not-a-valid-url', logger, false);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to generate S3 path');
      }
    });
  });

  describe('getTokowakaMetaconfigS3Path', () => {
    it('should generate correct metaconfig S3 path for deploy', () => {
      const url = 'https://example.com/page1';
      const logger = { error: () => {} };
      const result = getTokowakaMetaconfigS3Path(url, logger, false);
      expect(result).to.equal('opportunities/example.com/config');
    });

    it('should generate correct metaconfig S3 path for preview', () => {
      const url = 'https://example.com/page1';
      const logger = { error: () => {} };
      const result = getTokowakaMetaconfigS3Path(url, logger, true);
      expect(result).to.equal('preview/opportunities/example.com/config');
    });

    it('should throw error on invalid URL', () => {
      const logger = { error: () => {} };

      try {
        getTokowakaMetaconfigS3Path('not-a-valid-url', logger, false);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to generate metaconfig S3 path');
      }
    });
  });

  describe('base64UrlEncode', () => {
    it('should encode string to base64url', () => {
      const result = base64UrlEncode('/page1');
      expect(result).to.equal('L3BhZ2Ux');
    });

    it('should handle special characters', () => {
      const result = base64UrlEncode('/page?query=1');
      // Should replace + with - and / with _
      expect(result).to.not.include('+');
      expect(result).to.not.include('=');
    });
  });
});
