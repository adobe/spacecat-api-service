/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* eslint-disable no-await-in-loop */

import { tracingFetch } from '@adobe/spacecat-shared-utils';
import fs from 'fs';
import * as cheerio from 'cheerio';
import { franc } from 'franc-min';
import worldCountries from 'world-countries';
import { iso6393 } from 'iso-639-3';

const parseLocale = (locale) => {
  let language;
  let region;
  console.log(`Parsing locale: ${locale}`);

  // If it contains - or _, split into language and region
  if (locale.includes('-') || locale.includes('_')) {
    [language, region] = locale.toLowerCase().split(/[-_]/);
  } else {
    language = locale.toLowerCase();
  }

  // Validate language
  const lang = iso6393.find((l) => l.iso6393 === language || l.iso6391 === language);
  if (!lang) {
    console.log(`Invalid language: ${language}`);
    language = null;
  } else {
    language = lang.iso6391;
  }

  // Validate region
  if (region && !worldCountries.find((country) => country.cca2.toLowerCase() === region)) {
    console.log(`Invalid region: ${region}`);
    region = null;
  }

  if (!language && !region) {
    return null;
  }

  const result = {};
  if (language) {
    result.language = language;
  }
  if (region) {
    result.region = region;
  }
  return result;
};

const parseTld = (tld) => {
  const tld2 = `.${tld.toLowerCase()}`;
  const country = worldCountries.find((c) => c.tld.includes(tld2));
  if (country) {
    return {
      region: country.cca2.toLowerCase(),
    };
  }
  return null;
};

(async () => {
  // Parse sites.json and get a list of valid base urls
  const sites = JSON.parse(fs.readFileSync('src/sites.json', 'utf8'));
  let baseUrls = sites
    .map((site) => {
      try {
        return new URL(site.baseURL);
      } catch (error) {
        return null;
      }
    })
    .filter((url) => url !== null);

  // Select 5 random base urls
  baseUrls = baseUrls.sort(() => Math.random() - 0.5).slice(0, 1);

  for (const baseUrl of baseUrls) {
    const indicators = [];
    console.log(`Checking ${baseUrl}`);

    const tld = baseUrl.hostname.split('.').pop();
    if (tld) {
      const locale = parseTld(tld);
      if (locale) {
        indicators.push({ ...locale, type: 'tld' });
      }
    }

    // Check subdomain
    const hostnameParts = baseUrl.hostname.split('.');
    if (hostnameParts.length > 2) {
      const subdomain = hostnameParts[0];
      if (subdomain && subdomain.length === 2) {
        // We don't know if subdomain is language or region, try use as both
        const locale = parseLocale(`${subdomain}_${subdomain}`);
        if (locale) {
          indicators.push({ ...locale, type: 'subdomain' });
        }
      }
    }

    // Check path
    const path = baseUrl.pathname.replace(/\.html$/, '');
    if (path && path !== '/') {
      let pathSegments = path.split('/').filter((p) => p.length === 2);
      if (pathSegments.length === 2) {
        pathSegments = pathSegments.reverse();
      }
      const locale = parseLocale(pathSegments.join('_').trim());
      if (locale) {
        indicators.push({ ...locale, type: 'path' });
      }
    }

    try {
      const response = await tracingFetch(baseUrl, { timeout: 5000 });
      console.log(`Response: ${response.status}`);
      const { headers } = response;

      console.log(headers);

      // content-language HTTP header
      if (headers['content-language']) {
        console.log(`Content language: ${headers['content-language']} found`);
        const locale = parseLocale(headers['content-language']);
        if (locale) {
          indicators.push({ ...locale, type: 'header' });
        }
      }
      if (headers['x-content-language']) {
        console.log(`X-Content language: ${headers['x-content-language']} found`);
        const locale = parseLocale(headers['x-content-language']);
        if (locale) {
          indicators.push({ ...locale, type: 'header' });
        }
      }

      const context = await response.text();
      const $ = cheerio.load(context);

      // HTML lang
      const htmlLang = $('html').attr('lang');
      if (htmlLang) {
        console.log(`HTML lang: ${htmlLang} found`);
        const locale = parseLocale(htmlLang);
        if (locale) {
          indicators.push({ ...locale, type: 'htmlLang' });
        }
      }

      // Print out all meta tags
      $('meta').each((index, element) => {
        console.log(`Meta tag: ${$(element)} found`);
      });

      // Get all link hreflang tags
      const linkTags = $('link[hreflang]');
      linkTags.each((index, element) => {
        console.log(`Link tag: ${$(element)} found`);
      });

      const matchingLinkTag = Array.from(linkTags).find((element) => {
        const elementHref = new URL($(element).attr('href'));
        if (!`${elementHref.hostname}${elementHref.pathname}`.includes(`${baseUrl.hostname}${baseUrl.pathname}`)) {
          return false;
        }
        if ($(element).attr('hreflang').includes('default')) {
          return false;
        }
        return true;
      });
      if (matchingLinkTag) {
        console.log(`Matching Link tag: ${$(matchingLinkTag)} found`);
        const locale = parseLocale($(matchingLinkTag).attr('hreflang'));
        if (locale) {
          indicators.push({ ...locale, type: 'hreflang' });
        }
      }

      // Meta tags
      const metaContentLanguage = $('meta[property="content-language"]').attr('content');
      if (metaContentLanguage) {
        console.log(`Meta content language: ${metaContentLanguage} found`);
        const locale = parseLocale(metaContentLanguage);
        if (locale) {
          indicators.push({ ...locale, type: 'metaTag' });
        }
      }
      const metaOgLocale = $('meta[property="og:locale"]').attr('content');
      if (metaOgLocale) {
        console.log(`Meta og locale: ${metaOgLocale} found`);
        const locale = parseLocale(metaOgLocale);
        if (locale) {
          indicators.push({ ...locale, type: 'metaTag' });
        }
      }

      const metaDescription = $('meta[name="description"]').attr('content');
      if (metaDescription) {
        console.log(`Meta description: ${metaDescription} found`);
        const language = franc(metaDescription);
        const locale = parseLocale(language);
        if (locale) {
          indicators.push({ ...locale, type: 'content' });
        }
      }
    } catch (error) {
      console.error(`Error checking ${baseUrl}: ${error}`);
    }

    console.log(indicators);

    // Generate summary by number of indicators
    const summary = indicators.reduce((acc, indicator) => {
      if (indicator.region) {
        acc.region[indicator.region] = (acc.region[indicator.region] || 0) + 1;
      }
      if (indicator.language) {
        acc.language[indicator.language] = (acc.language[indicator.language] || 0) + 1;
      }
      return acc;
    }, { region: {}, language: {} });
    const region = Object.keys(summary.region).length > 0 ? Object.keys(summary.region).sort((a, b) => summary.region[b] - summary.region[a])[0] : 'us';
    const language = Object.keys(summary.language).length > 0 ? Object.keys(summary.language).sort((a, b) => summary.language[b] - summary.language[a])[0] : 'en';

    console.log(summary);
    console.log(`Region: ${region}`);
    console.log(`Language: ${language}`);
  }
})();
