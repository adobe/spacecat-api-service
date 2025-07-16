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
import LlmoController from '../../src/controllers/llmo.js';

async function readStreamToJson(stream) {
  let data = '';
  for await (const chunk of stream) {
    data += chunk;
  }
  return JSON.parse(data);
}

describe('LLMO Controller', () => {
  let llmoController;

  beforeEach(() => {
    llmoController = LlmoController();
  });

  describe('getLlmoData', () => {
    it('should return dummy agentic data with current date and time', async () => {
      const mockContext = {
        params: {
          siteId: 'test-site-id',
          dataSource: 'test-data-source',
        },
      };

      const result = await llmoController.getLlmoData(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.have.property('timestamp');
      expect(body).to.have.property('currentDate');
      expect(body).to.have.property('currentTime');
      expect(body).to.have.property('siteId', 'test-site-id');
      expect(body).to.have.property('dataSource', 'test-data-source');
      expect(body).to.have.property('agenticMetrics');
      expect(body).to.have.property('agenticFeatures');
      expect(body).to.have.property('performanceMetrics');
      expect(body).to.have.property('systemStatus');

      // Verify agenticMetrics structure
      expect(body.agenticMetrics).to.have.property('userEngagement');
      expect(body.agenticMetrics).to.have.property('contentRelevance');
      expect(body.agenticMetrics).to.have.property('searchAccuracy');
      expect(body.agenticMetrics).to.have.property('responseTime');
      expect(body.agenticMetrics).to.have.property('satisfactionScore');

      // Verify agenticFeatures structure
      expect(body.agenticFeatures).to.have.property('personalizedRecommendations');
      expect(body.agenticFeatures).to.have.property('intelligentSearch');
      expect(body.agenticFeatures).to.have.property('predictiveAnalytics');
      expect(body.agenticFeatures).to.have.property('automatedInsights');
      expect(body.agenticFeatures).to.have.property('contextualAssistance');

      // Verify performanceMetrics structure
      expect(body.performanceMetrics).to.have.property('accuracy');
      expect(body.performanceMetrics).to.have.property('precision');
      expect(body.performanceMetrics).to.have.property('recall');
      expect(body.performanceMetrics).to.have.property('f1Score');

      // Verify systemStatus structure
      expect(body.systemStatus).to.have.property('status', 'operational');
      expect(body.systemStatus).to.have.property('lastUpdated');
      expect(body.systemStatus).to.have.property('uptime');
      expect(body.systemStatus).to.have.property('activeUsers');

      // Verify data types
      expect(body.agenticMetrics.userEngagement).to.be.a('number');
      expect(body.agenticMetrics.contentRelevance).to.be.a('number');
      expect(body.agenticMetrics.searchAccuracy).to.be.a('number');
      expect(body.agenticMetrics.responseTime).to.be.a('number');
      expect(body.agenticMetrics.satisfactionScore).to.be.a('number');

      expect(body.agenticFeatures.personalizedRecommendations).to.be.a('boolean');
      expect(body.agenticFeatures.intelligentSearch).to.be.a('boolean');
      expect(body.agenticFeatures.predictiveAnalytics).to.be.a('boolean');
      expect(body.agenticFeatures.automatedInsights).to.be.a('boolean');
      expect(body.agenticFeatures.contextualAssistance).to.be.a('boolean');

      expect(body.performanceMetrics.accuracy).to.be.a('string');
      expect(body.performanceMetrics.precision).to.be.a('string');
      expect(body.performanceMetrics.recall).to.be.a('string');
      expect(body.performanceMetrics.f1Score).to.be.a('string');

      expect(body.systemStatus.uptime).to.be.a('string');
      expect(body.systemStatus.activeUsers).to.be.a('number');
    });

    it('should handle different siteId and dataSource parameters', async () => {
      const mockContext = {
        params: {
          siteId: 'different-site-id',
          dataSource: 'different-data-source',
        },
      };

      const result = await llmoController.getLlmoData(mockContext);
      const body = await readStreamToJson(result.body);

      expect(body).to.have.property('siteId', 'different-site-id');
      expect(body).to.have.property('dataSource', 'different-data-source');
    });
  });
});
