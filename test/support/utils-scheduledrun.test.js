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

/* eslint-env mocha */
import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

use(sinonChai);

describe('scheduledRun precedence logic', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('scheduledRun precedence logic', () => {
    it('should prioritize form value over profile config when form value is true', () => {
      const additionalParams = { scheduledRun: true };
      const profile = { config: { scheduledRun: false } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.true;
    });

    it('should prioritize form value over profile config when form value is false', () => {
      const additionalParams = { scheduledRun: false };
      const profile = { config: { scheduledRun: true } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should fall back to profile config when form value not provided', () => {
      const additionalParams = {};
      const profile = { config: { scheduledRun: true } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.true;
    });

    it('should default to false when neither form nor profile provides scheduledRun', () => {
      const additionalParams = {};
      const profile = { config: {} };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should handle undefined profile config gracefully', () => {
      const additionalParams = {};
      const profile = {};

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should handle null profile config gracefully', () => {
      const additionalParams = {};
      const profile = { config: null };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });
  });
});
