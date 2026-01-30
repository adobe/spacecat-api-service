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

import { expect } from 'chai';
import sinon from 'sinon';
import { calculateConsentBounceGapLoss } from '../../../src/controllers/paid/bounce-gap-calculator.js';

describe('Bounce Gap Calculator', () => {
  let sandbox;
  let mockLog;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockLog = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('calculateConsentBounceGapLoss', () => {
    it('calculates bounce gap loss correctly with both consent states', () => {
      const results = [
        {
          device: 'desktop',
          consent: 'show',
          pageviews: '10000',
          bounce_rate: '0.50',
        },
        {
          device: 'desktop',
          consent: 'hidden',
          pageviews: '10000',
          bounce_rate: '0.40',
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['device'], mockLog);

      expect(bounceGapResult.projectedTrafficLost).to.be.closeTo(1000, 1);
      expect(bounceGapResult.hasShowData).to.be.true;
      expect(bounceGapResult.hasHiddenData).to.be.true;
      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(1);
      expect(bounceGapResult.byDimension.desktop.loss).to.be.closeTo(1000, 1);
      expect(bounceGapResult.byDimension.desktop.delta).to.be.closeTo(0.10, 0.001);
    });

    it('handles missing treatment data (only control present)', () => {
      const results = [
        {
          device: 'desktop',
          consent: 'hidden', // Only control, no treatment
          pageviews: '10000',
          bounce_rate: '0.40',
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['device'], mockLog);

      expect(bounceGapResult.projectedTrafficLost).to.equal(0);
      expect(bounceGapResult.hasShowData).to.be.false;
      expect(bounceGapResult.hasHiddenData).to.be.true;
      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(0);
      expect(mockLog.warn).to.have.been.calledWithMatch('[bounce-gap] Missing consent data');
    });

    it('handles missing control data (only treatment present)', () => {
      const results = [
        {
          device: 'mobile',
          consent: 'show', // Only treatment, no control
          pageviews: '5000',
          bounce_rate: '0.60',
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['device'], mockLog);

      expect(bounceGapResult.projectedTrafficLost).to.equal(0);
      expect(bounceGapResult.hasShowData).to.be.true;
      expect(bounceGapResult.hasHiddenData).to.be.false;
      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(0);
      expect(mockLog.warn).to.have.been.calledWithMatch('[bounce-gap] Missing consent data');
    });

    it('handles multiple dimensions correctly', () => {
      const results = [
        {
          path: '/page1',
          device: 'desktop',
          consent: 'show',
          pageviews: '8000',
          bounce_rate: '0.45',
        },
        {
          path: '/page1',
          device: 'desktop',
          consent: 'hidden',
          pageviews: '8000',
          bounce_rate: '0.35',
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['path', 'device'], mockLog);

      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(1);
      expect(bounceGapResult.byDimension['/page1|desktop'].loss).to.be.closeTo(800, 1);
      expect(bounceGapResult.byDimension['/page1|desktop'].delta).to.be.closeTo(0.10, 0.001);
    });

    it('handles missing dimension values with "unknown" fallback', () => {
      const results = [
        {
          device: 'desktop',
          consent: 'show',
          pageviews: '3000',
          bounce_rate: '0.50',
          // path is missing
        },
        {
          device: 'desktop',
          consent: 'hidden',
          pageviews: '3000',
          bounce_rate: '0.40',
          // path is missing
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['path', 'device'], mockLog);

      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(1);
      expect(bounceGapResult.byDimension['unknown|desktop']).to.exist;
      expect(bounceGapResult.byDimension['unknown|desktop'].loss).to.be.closeTo(300, 1);
    });

    it('skips dimension groups with incomplete consent data while processing others', () => {
      const results = [
        // Desktop has both consent states - should be processed
        {
          device: 'desktop',
          consent: 'show',
          pageviews: '10000',
          bounce_rate: '0.50',
        },
        {
          device: 'desktop',
          consent: 'hidden',
          pageviews: '10000',
          bounce_rate: '0.40',
        },
        // Mobile only has 'show' - should be skipped
        {
          device: 'mobile',
          consent: 'show',
          pageviews: '5000',
          bounce_rate: '0.60',
        },
        // Tablet only has 'hidden' - should be skipped
        {
          device: 'tablet',
          consent: 'hidden',
          pageviews: '3000',
          bounce_rate: '0.30',
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['device'], mockLog);

      // Only desktop should be in the results
      expect(Object.keys(bounceGapResult.byDimension)).to.have.lengthOf(1);
      expect(bounceGapResult.byDimension.desktop).to.exist;
      expect(bounceGapResult.byDimension.desktop.loss).to.be.closeTo(1000, 1);

      // Should have logged debug messages for skipped groups
      expect(mockLog.debug).to.have.been.calledWithMatch('[bounce-gap] Missing data for mobile');
      expect(mockLog.debug).to.have.been.calledWithMatch('[bounce-gap] Missing data for tablet');

      // Overall flags should still be true since we have at least one of each
      expect(bounceGapResult.hasShowData).to.be.true;
      expect(bounceGapResult.hasHiddenData).to.be.true;
    });

    it('handles missing or invalid bounce_rate values', () => {
      const results = [
        {
          device: 'desktop',
          consent: 'show',
          pageviews: '10000',
          bounce_rate: null, // Missing bounce rate
        },
        {
          device: 'desktop',
          consent: 'hidden',
          pageviews: '10000',
          bounce_rate: 'invalid', // Invalid bounce rate
        },
      ];

      const bounceGapResult = calculateConsentBounceGapLoss(results, ['device'], mockLog);

      // Should handle gracefully with 0 as fallback
      expect(bounceGapResult.byDimension.desktop).to.exist;
      expect(bounceGapResult.byDimension.desktop.loss).to.equal(0); // 10000 * max(0, 0 - 0) = 0
      expect(bounceGapResult.byDimension.desktop.delta).to.equal(0);
    });
  });
});
