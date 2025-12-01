/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * This file contains HTTP status code constants used throughout the application.
 */

export const STATUS_BAD_REQUEST = 400;
export const STATUS_ACCEPTED = 202;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_FORBIDDEN = 403;
export const STATUS_CREATED = 201;
export const STATUS_NO_CONTENT = 204;
export const STATUS_NOT_FOUND = 404;
export const STATUS_OK = 200;
export const STATUS_INTERNAL_SERVER_ERROR = 500;

/**
 * Report types enum
 */
export const REPORT_TYPES = {
  OPTIMIZATION: 'optimization',
  PERFORMANCE: 'performance',
};

/**
 * Opportunity tag mappings for different opportunity types
 */
export const OPPORTUNITY_TAG_MAPPINGS = {
  // Web Performance
  cwv: ['Core Web Vitals', 'Web Performance'],

  // Traffic Acquisition - SEO
  metatags: ['Meta Tags', 'SEO'],
  'internal-links': ['Internal links', 'SEO', 'Engagement'],
  'broken-backlinks': ['Backlinks', 'SEO'],
  'broken-internal-links': ['Backlinks', 'SEO'],
  sitemap: ['Sitemap', 'SEO'],
  canonical: ['Canonical URLs', 'SEO'],
  hreflang: ['Hreflang', 'SEO'],
  'structured-data': ['Structured Data', 'SEO'],
  'redirect-chains': ['Redirect Chains', 'SEO'],
  headings: ['Headings', 'SEO', 'Engagement'],

  // Traffic Acquisition - Paid Media
  'consent-banner': ['Consent Banner', 'Engagement'],

  // Compliance & Accessibility
  'a11y-assistive': ['ARIA Labels', 'Accessibility'],
  'color-contrast': ['Color Constrast', 'Accessibility', 'Engagement'],
  'keyboard-access': ['Keyboard Access', 'Accessibility'],
  readability: ['Readbability', 'Accessibility', 'Engagement'],
  'screen-readers': ['Screen Readers', 'Accessibility'],
  'alt-text': ['Alt-Text', 'Accessibility', 'SEO'],
  'form-a11y': ['Form Accessibility', 'Accessibility', 'Engagement'],

  // Engagement & Conversion
  'high-organic-low-ctr': ['Low CTR', 'Engagement'],
  'high-page-views-low-form-views': ['Form Visibility', 'Engagement'],
  'high-page-views-low-form-nav': ['Form Placement', 'Engagement'],
  'high-form-views-low-conversions': ['Form CTR', 'Conversion'],

  // Security
  'security-xss': ['Cross Site Scripting', 'Security'],
  'security-libraries': ['3rd Party Libraries', 'Security'],
  'security-permissions': ['Permission Settings', 'Security'],
  'security-cors': ['CORS', 'Security'],
};
