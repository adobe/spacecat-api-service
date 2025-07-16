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

import { ok } from '@adobe/spacecat-shared-http-utils';

function LlmoController() {
  const getLlmoData = async (context) => {
    const { siteId, dataSource } = context.params;
    const now = new Date();

    // Generate dummy agentic values
    const dummyAgenticData = {
      timestamp: now.toISOString(),
      currentDate: now.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      currentTime: now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      siteId,
      dataSource,
      agenticMetrics: {
        userEngagement: Math.random() * 100,
        contentRelevance: Math.random() * 100,
        searchAccuracy: Math.random() * 100,
        responseTime: Math.random() * 2000 + 100,
        satisfactionScore: Math.random() * 5 + 1,
      },
      agenticFeatures: {
        personalizedRecommendations: Math.random() > 0.5,
        intelligentSearch: Math.random() > 0.5,
        predictiveAnalytics: Math.random() > 0.5,
        automatedInsights: Math.random() > 0.5,
        contextualAssistance: Math.random() > 0.5,
      },
      performanceMetrics: {
        accuracy: (Math.random() * 20 + 80).toFixed(2),
        precision: (Math.random() * 15 + 85).toFixed(2),
        recall: (Math.random() * 10 + 90).toFixed(2),
        f1Score: (Math.random() * 10 + 90).toFixed(2),
      },
      systemStatus: {
        status: 'operational',
        lastUpdated: now.toISOString(),
        uptime: `${Math.floor(Math.random() * 100)}%`,
        activeUsers: Math.floor(Math.random() * 10000) + 1000,
      },
    };

    return ok(dummyAgenticData);
  };

  return {
    getLlmoData,
  };
}

export default LlmoController;
