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

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { composeBaseURL, hasText } from '@adobe/spacecat-shared-utils';
import { badRequest, ok } from '@adobe/spacecat-shared-http-utils';

async function generatePresignedUrl(s3, bucket, siteId, pathname, variant) {
  const key = `scrapes/${siteId}${pathname}${pathname.endsWith('/') ? '' : '/'}${variant}.png`;
  console.log(`key: ${key}`);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // 7 days
  const expiresIn = 60 * 60 * 24 * 7;

  return getSignedUrl(s3, command, { expiresIn });
}

/*
 * FOR DEMO PURPOSES
 * NOT FOR PRODUCTION - THE FILE WILL BE REMOVED
 */

function DemoController(ctx) {
  const { dataAccess, s3 } = ctx;

  const { Site } = dataAccess;

  const getScreenshots = async (context) => {
    const { S3_SCRAPER_BUCKET: bucketName } = context.env;
    const { url } = context.data;

    if (!hasText(url) || !URL.canParse(url)) {
      return badRequest(`No valid URL provided: ${url}`);
    }

    const { origin, pathname } = new URL(url);

    const site = await Site.findByBaseURL(composeBaseURL(origin));

    const desktopOn = await generatePresignedUrl(s3, bucketName, site.getId(), pathname, 'screenshot-desktop-viewport');
    const desktopOff = await generatePresignedUrl(s3, bucketName, site.getId(), pathname, 'consent-banner-off/screenshot-desktop-viewport');

    const mobileOn = await generatePresignedUrl(s3, bucketName, site.getId(), pathname, 'screenshot-iphone-6-viewport');
    const mobileOff = await generatePresignedUrl(s3, bucketName, site.getId(), pathname, 'consent-banner-off/screenshot-iphone-6-viewport');

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
  };
}

export default DemoController;
