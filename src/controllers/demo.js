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

import { composeBaseURL, hasText } from '@adobe/spacecat-shared-utils';
import { badRequest, notFound, ok } from '@adobe/spacecat-shared-http-utils';
import { HeadObjectCommand } from '@aws-sdk/client-s3';

function getKey(siteId, pathname, variant) {
  return `scrapes/${siteId}${pathname}${pathname.endsWith('/') ? '' : '/'}${variant}.png`;
}

async function exists(s3, bucket, key) {
  try {
    const { s3Client } = s3;
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    return false;
  }
}

async function generatePresignedUrl(s3, bucket, key) {
  const {
    s3Client,
    getSignedUrl,
    GetObjectCommand,
  } = s3;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // 7 days
  const expiresIn = 60 * 60 * 24 * 7;

  return getSignedUrl(s3Client, command, { expiresIn });
}

/*
 * FOR DEMO PURPOSES
 * NOT FOR PRODUCTION - THE FILE WILL BE REMOVED
 */

function DemoController(ctx) {
  const { dataAccess, s3 } = ctx;

  const { Site } = dataAccess;

  const takeScreenshots = async (context) => {
    const { sqs } = context;
    const { SCRAPING_JOBS_QUEUE_URL: queueUrl } = context.env;
    const { url } = context.data;

    if (!hasText(url) || !URL.canParse(url)) {
      return badRequest(`No valid URL provided: ${url}`);
    }

    const { origin } = new URL(url);

    const site = await Site.findByBaseURL(composeBaseURL(origin));

    // with banner
    await sqs.sendMessage(queueUrl, {
      processingType: 'default',
      jobId: site.getId(),
      skipMessage: true,
      skipStorage: false,
      options: {
        storagePrefix: 'consent-banner-on',
        enableJavaScript: true,
        enableAuthentication: false,
        screenshotTypes: [
          'viewport',
        ],
        waitForSelector: '#onetrust-policy-text',
      },
      urls: [{
        url,
      }],
    });

    // without banner
    await sqs.sendMessage(queueUrl, {
      processingType: 'default',
      jobId: site.getId(),
      skipMessage: true,
      skipStorage: false,
      options: {
        storagePrefix: 'consent-banner-off',
        enableJavaScript: true,
        enableAuthentication: false,
        screenshotTypes: ['viewport'],
        hideConsentBanners: true,
      },
      urls: [{
        url,
      }],
    });

    return ok('done.');
  };

  const getScreenshots = async (context) => {
    const { S3_SCRAPER_BUCKET: bucketName } = context.env;
    const { url, forceCapture = false } = context.data;

    if (!hasText(url) || !URL.canParse(url)) {
      return badRequest(`No valid URL provided: ${url}`);
    }

    const { origin, pathname } = new URL(url);

    const site = await Site.findByBaseURL(composeBaseURL(origin));

    const desktopOnKey = getKey(site.getId(), pathname, 'screenshot-desktop-viewport');
    const desktopOffKey = getKey(site.getId(), pathname, 'consent-banner-off/screenshot-desktop-viewport');
    const mobileOnKey = getKey(site.getId(), pathname, 'screenshot-iphone-6-viewport');
    const mobileOffKey = getKey(site.getId(), pathname, 'consent-banner-off/screenshot-iphone-6-viewport');

    const checks = await Promise.all(
      [desktopOnKey, desktopOffKey, mobileOnKey, mobileOffKey]
        .map((key) => exists(s3, bucketName, key)),
    );
    if (checks.some((exist) => !exist)) {
      let message = 'Some/all of the screenshots requested does not exist.';
      if (forceCapture) {
        await takeScreenshots(context);
        message += ' Initiated taking screenshots. Try again in a few secs.';
      }
      return notFound(message);
    }

    const desktopOn = await generatePresignedUrl(s3, bucketName, desktopOnKey);
    const desktopOff = await generatePresignedUrl(s3, bucketName, desktopOffKey);
    const mobileOn = await generatePresignedUrl(s3, bucketName, mobileOnKey);
    const mobileOff = await generatePresignedUrl(s3, bucketName, mobileOffKey);

    const result = {
      mobile_cookie_banner_on: mobileOn,
      mobile_cookie_banner_off: mobileOff,
      desktop_cookie_banner_on: desktopOn,
      desktop_cookie_banner_off: desktopOff,
    };

    return ok(result);
  };

  return {
    getScreenshots,
    takeScreenshots,
  };
}

export default DemoController;
