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

import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  createResponse,
  ok,
  accepted,
  notFound,
  badRequest,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
} from '@adobe/spacecat-shared-utils';

function ConsentBannerController(ctx) {
  const { s3 } = ctx;
  const { log } = ctx;
  const scrapeClient = ScrapeClient.createFrom(ctx);

  const HEADER_ERROR = 'x-error';

  function parseRequestContext(requestContext) {
    return {
      // more params to add here?
      jobId: requestContext.params.jobId,
    };
  }

  function createErrorResponse(error) {
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: error.message,
    });
  }

  function getImageKey(jobId, resultPath, variant) {
    // resultPath points to the scrape.json file in the target directory
    // take the resultPath, remove the scrape.json file, and add the variant
    return resultPath.replace('/scrape.json', `/${variant}.png`);
  }

  async function generatePresignedUrl(s3Ctx, bucket, key) {
    const {
      s3Client,
      getSignedUrl,
      GetObjectCommand,
    } = s3Ctx;

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    // 7 days
    const expiresIn = 60 * 60 * 24 * 7;

    return getSignedUrl(s3Client, command, { expiresIn });
  }

  async function takeScreenshots(requestContext) {
    const { data } = requestContext;
    const { url } = data;

    try {
      if (!hasText(url) || !URL.canParse(url)) {
        return badRequest(`No valid URL provided: ${url}`);
      }

      const job = await scrapeClient.createScrapeJob({
        urls: [url],
        processingType: 'consent-banner',
        options: {
          enableJavaScript: true,
          screenshotTypes: ['viewport'],
          rejectRedirects: false,
        },
      });

      return accepted(job);
    } catch (error) {
      log.error(error?.message || error);
      if (error?.message?.includes('Invalid request')) {
        return badRequest(error);
      } else if (error?.message?.includes('Service Unavailable')) {
        error.status = 503;
        return createErrorResponse(error);
      }
      return createErrorResponse(error);
    }
  }

  async function getScreenshots(requestContext) {
    const { S3_SCRAPER_BUCKET: bucketName } = ctx.env;
    const { jobId } = parseRequestContext(requestContext);

    /*
    mobile_cookie_banner_on: mobileOn,
      mobile_cookie_banner_off: mobileOff,
      desktop_cookie_banner_on: desktopOn,
      desktop_cookie_banner_off: desktopOff,
    */
    const fileVariants = [
      { key: 'desktop_cookie_banner_on', variant: 'screenshot-desktop-viewport-withBanner' },
      { key: 'desktop_cookie_banner_off', variant: 'screenshot-desktop-viewport-withoutBanner' },
      { key: 'mobile_cookie_banner_on', variant: 'screenshot-iphone-6-viewport-withBanner' },
      { key: 'mobile_cookie_banner_off', variant: 'screenshot-iphone-6-viewport-withoutBanner' },
    ];

    try {
      const [result] = await scrapeClient.getScrapeJobUrlResults(jobId);

      if (result.status === 'PENDING') {
        return notFound('Scrape job is still running. Try again in a few secs.');
      } else if (result.status === 'FAILED') {
        return internalServerError(`Scrape job failed: ${result.reason}`);
      }

      // fetch the scrape.json file
      const scrapeJsonUrl = await generatePresignedUrl(s3, bucketName, result.path);
      const scrapeJson = await fetch(scrapeJsonUrl);
      const scrapeJsonData = await scrapeJson.json();

      // iterate over fileVariants, the output of it all should be
      // an object with the key as property and the value as the presigned url
      // the object should contain properties for each of the fileVariants
      // assign this to results
      const urlPromises = fileVariants.map(async (variant) => {
        const key = getImageKey(jobId, result.path, variant.variant);
        const url = await generatePresignedUrl(s3, bucketName, key);
        return { key: variant.key, url };
      });

      const urlResults = await Promise.all(urlPromises);
      const results = urlResults.reduce((acc, { key, url }) => {
        acc[key] = url;
        return acc;
      }, {});

      return ok({
        jobId,
        results: {
          ...results,
          screenshots: scrapeJsonData.screenshots,
          dimensionsDevice: scrapeJsonData.device,
          scrapeTime: scrapeJsonData.scrapeTime,
          dimensions: scrapeJsonData.scrapeResult.results,
        },
      });
    } catch (error) {
      log.error(error?.message || error);
      return createErrorResponse(error);
    }
  }

  return {
    getScreenshots,
    takeScreenshots,
    __testHelpers: {
      parseRequestContext,
      getImageKey,
      generatePresignedUrl,
    },
  };
}

export default ConsentBannerController;
