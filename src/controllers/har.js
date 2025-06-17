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

/* c8 ignore start */

import PuppeteerHar from 'puppeteer-har';
import puppeteer, { PredefinedNetworkConditions } from 'puppeteer';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import {
  ok,
} from '@adobe/spacecat-shared-http-utils';

// HAR Processing Functions
function cleanupHarData(har) {
  // Remove preflight requests (OPTIONS) from HAR data
  if (har?.log?.entries) {
    // eslint-disable-next-line no-param-reassign
    har.log.entries = har.log.entries.filter((entry) => !(entry.request && entry.request.method === 'OPTIONS'));
  }
  return har;
}

function findLargeTransfers(entries, report) {
  // 1. Large Transfer Sizes (Top 5, > 100KB)
  const largeFiles = entries
    // eslint-disable-next-line no-underscore-dangle
    .filter((entry) => entry.response && entry.response._transferSize > 100 * 1024) // > 100KB
    // eslint-disable-next-line no-underscore-dangle
    .sort((a, b) => b.response._transferSize - a.response._transferSize)
    .slice(0, 5); // Limit to top 5

  if (largeFiles.length > 0) {
    // eslint-disable-next-line no-param-reassign, no-unused-vars
    report += '* **Large File Transfers:**\n';
    largeFiles.forEach((entry) => {
      // eslint-disable-next-line no-param-reassign, no-underscore-dangle
      report += `    * ${entry.request.url} (${Math.round(entry.response._transferSize / 1024)} KB)\n`;
    });
    return true;
  }
  return false;
}

function findLongBlockingTimes(entries, report) {
  // 2. Long Blocking Times (> 10ms)
  const longBlocking = entries
    .filter((entry) => entry.timings && entry.timings.blocked > 10)
    .sort((a, b) => b.timings.blocked - a.timings.blocked);

  if (longBlocking.length > 0) {
    // eslint-disable-next-line no-param-reassign, no-unused-vars
    report += '* **Significant Blocking Times (DNS, Connect, SSL):**\n';
    longBlocking.forEach((entry) => {
      // eslint-disable-next-line no-param-reassign
      report += `    * ${entry.request.url}:  Blocked: ${Math.round(entry.timings.blocked)}ms`;
      if (entry.timings.dns > 0) {
        // eslint-disable-next-line no-param-reassign
        report += `, DNS: ${Math.round(entry.timings.dns)}ms`;
      }
      if (entry.timings.connect > 0) {
        // eslint-disable-next-line no-param-reassign
        report += `, Connect: ${Math.round(entry.timings.connect)}ms`;
      }
      if (entry.timings.ssl > 0) {
        // eslint-disable-next-line no-param-reassign
        report += `, SSL: ${Math.round(entry.timings.ssl)}ms`;
      }
      // eslint-disable-next-line no-param-reassign
      report += '\n';
    });
    return true;
  }
  return false;
}

function findLongTTFB(entries, report, deviceType) {
  // 3. Long Wait Times (> 500ms desktop / >1s mobile) - TTFB
  const ttfbThreshold = deviceType === 'desktop' ? 500 : 1000;
  const longTTFB = entries
    .filter((entry) => entry.timings && entry.timings.wait > ttfbThreshold)
    .sort((a, b) => b.timings.wait - a.timings.wait);

  if (longTTFB.length > 0) {
    // eslint-disable-next-line no-param-reassign
    report += '* **High Time to First Byte (TTFB) - Server Response Times:**\n';
    longTTFB.forEach((entry) => {
      // eslint-disable-next-line no-param-reassign
      report += `    * ${entry.request.url}: ${Math.round(entry.timings.wait)}ms\n`;
    });
    return true;
  }
  return false;
}

function findHTTP1Resources(entries, report) {
  // 4. HTTP/1.1 Connections
  const http1Resources = entries.filter((entry) => entry.response && entry.response.httpVersion.toLowerCase().startsWith('http/1.1'));

  if (http1Resources.length > 0) {
    // eslint-disable-next-line no-param-reassign, no-unused-vars
    report += '* **Resources using HTTP/1.1 (not HTTP/2 or HTTP/3):**\n';
    http1Resources.forEach((entry) => {
      // eslint-disable-next-line no-param-reassign
      report += `   * ${entry.request.url}\n`;
    });
    return true;
  }
  return false;
}

function findRedirects(entries, report) {
  // 5. Redirects
  const redirectStatusCodes = [301, 302, 307, 308];
  const redirects = entries.filter((entry) => entry.response
  && redirectStatusCodes.includes(entry.response.status));

  if (redirects.length > 0) {
    // eslint-disable-next-line no-param-reassign, no-unused-vars
    report += '* **Redirects:**\n';
    redirects.forEach((entry) => {
    // eslint-disable-next-line no-param-reassign
      report += `    * ${entry.request.url} -> ${entry.response.redirectURL} (Status: ${entry.response.status})\n`;
    });
    return true;
  }
  return false;
}

function analyzeBottlenecks(entries, report, deviceType) {
  let hasBottlenecks = false;

  // Add bottleneck analyses
  hasBottlenecks = findLargeTransfers(entries, report) || hasBottlenecks;
  hasBottlenecks = findLongBlockingTimes(entries, report) || hasBottlenecks;
  hasBottlenecks = findLongTTFB(entries, report, deviceType) || hasBottlenecks;
  hasBottlenecks = findHTTP1Resources(entries, report) || hasBottlenecks;
  hasBottlenecks = findRedirects(entries, report) || hasBottlenecks;

  return hasBottlenecks;
}

// HAR Analysis Functions
function summarizeHAR(harData, deviceType) {
  if (!harData?.log?.entries) {
    return 'No valid HTTP Archive data available.';
  }

  const { entries } = harData.log;
  let report = '**Additional Bottlenecks from HAR Data:**\n\n';
  let hasBottlenecks = false;

  // Check for different types of bottlenecks
  hasBottlenecks = analyzeBottlenecks(entries, report, deviceType);

  // No significant bottlenecks found
  if (!hasBottlenecks) {
    report += '* No significant bottlenecks found based on provided HAR data.\n';
  }

  return report;
}

// HAR Recording Functions
async function startHARRecording(page) {
  const har = new PuppeteerHar(page);
  await har.start();
  return har;
}
async function stopHARRecording(har) {
  const harData = await har.stop();
  return cleanupHarData(harData);
}

// Standard User Agents for different scenarios
const USER_AGENTS = {
  psi: {
    desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Spacecat/1.0',
    mobile: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Spacecat/1.0',
  },
};

// Device configuration profiles
const simulationConfig = {
  desktop: {
    cpuThrottling: 1,
    networkThrottling: {
      download: 10240 * 1024,
      upload: 10240 * 1024,
      latency: 40,
    },
    viewport: {
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      isMobile: false,
      isLandscape: true,
    },
    psiUserAgent: USER_AGENTS.psi.desktop,
  },
  mobile: {
    cpuThrottling: 4,
    networkThrottling: PredefinedNetworkConditions['Slow 4G'],
    viewport: {
      width: 412,
      height: 823,
      deviceScaleFactor: 1.75,
      isMobile: true,
      isLandscape: false,
    },
    psiUserAgent: USER_AGENTS.psi.mobile,
  },
};

async function setupRequestBlocking(page, blockRequests) {
  if (!blockRequests) return;

  const blockedUrls = blockRequests.split(',');
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    const filtered = blockedUrls.some((b) => url.includes(b.trim()));

    if (filtered) {
      request.abort();
    } else {
      request.continue();
    }
  });
}

async function setupBrowser(deviceType, blockRequests) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Setup CDP session for Performance metrics and coverage
  const client = await page.createCDPSession();
  await client.send('Performance.enable');

  // Apply device configuration
  await page.setViewport(simulationConfig[deviceType].viewport);
  await page.emulateCPUThrottling(simulationConfig[deviceType].cpuThrottling);
  await page.emulateNetworkConditions(simulationConfig[deviceType].networkThrottling);
  await page.setUserAgent(simulationConfig[deviceType].psiUserAgent);

  // Setup request blocking if needed
  await setupRequestBlocking(page, blockRequests);

  return { browser, page };
}

/**
 * Har controller.
 * @param {object} ctx - Context object.
 * @returns {object} Bundles controller.
 * @constructor
 */
function HarController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  /**
     * Gets all bundles for a given url, and date range.
     *
     * @returns {Promise<Response>} Array of bundles response.
     */
  async function getHar({ params: { url, deviceType = 'desktop' } }) {
    const pageUrl = Buffer.from(url, 'base64').toString('utf-8');
    let harFile = null;

    const { browser, page } = await setupBrowser(deviceType, '');

    let har = null;
    if (!harFile) {
      har = await startHARRecording(page);
    }

    await page.goto(pageUrl, {
      timeout: 120_000,
      waitUntil: 'domcontentloaded',
    });

    await page.waitForNetworkIdle({ concurrency: 0, idleTime: 1_000 });

    if (!harFile) {
      harFile = await stopHARRecording(har);
    }

    await browser.close();

    const result = summarizeHAR(harFile, deviceType);
    return ok({ report: result });
  }

  return {
    getHar,
  };
}

export default HarController;

/* c8 ignore end */
