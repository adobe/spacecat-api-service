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

  // Traffic Acquisition
  metatags: ['Traffic Acquisition', 'Meta Tags', 'SEO'],
  'internal-links': ['Traffic Acquisition', 'Internal links', 'SEO', 'Engagement'],
  'broken-backlinks': ['Traffic Acquisition', 'Backlinks', 'SEO'],
  'broken-internal-links': ['Traffic Acquisition', 'Backlinks', 'SEO'],
  sitemap: ['Traffic Acquisition', 'Sitemap', 'SEO'],
  canonical: ['Traffic Acquisition', 'Canonical URLs', 'SEO'],
  hreflang: ['Traffic Acquisition', 'Hreflang', 'SEO'],
  'structured-data': ['Traffic Acquisition', 'Structured Data', 'SEO'],
  'redirect-chains': ['Traffic Acquisition', 'Redirect Chains', 'SEO', 'Traffic Acquisition'],
  'consent-banner': ['Traffic Acquisition', 'Consent Banner', 'Engagement'],
  headings: ['Traffic Acquisition', 'Headings', 'SEO', 'Engagement'],

  // Compliance & Accessibility
  'a11y-assistive': ['Compliance & Accessibility', 'ARIA Labels', 'Accessibility'],
  'color-contrast': ['Compliance & Accessibility', 'Color Constrast', 'Accessibility', 'Engagement'],
  'keyboard-access': ['Compliance & Accessibility', 'Keyboard Access', 'Accessibility'],
  readability: ['Compliance & Accessibility', 'Readbability', 'Accessibility', 'Engagement'],
  'screen-readers': ['Compliance & Accessibility', 'Screen Readers', 'Accessibility'],
  'alt-text': ['Compliance & Accessibility', 'Alt-Text', 'Accessibility', 'SEO'],
  'form-a11y': ['Compliance & Accessibility', 'Form Accessibility', 'Accessibility', 'Engagement'],

  // Engagement & Conversion
  'high-organic-low-ctr': ['Engagement & Conversion', 'Low CTR', 'Engagement'],
  'high-page-views-low-form-views': ['Engagement & Conversion', 'Form Visibility', 'Engagement'],
  'high-page-views-low-form-nav': ['Engagement & Conversion', 'Form Placement', 'Engagement'],
  'high-form-views-low-conversions': ['Engagement & Conversion', 'Form CTR', 'Conversion'],

  // Security
  'security-xss': ['Security', 'Cross Site Scripting', 'Security'],
  'security-libraries': ['Security', '3rd Party Libraries', 'Security'],
  'security-permissions': ['Security', 'Permission Settings', 'Security'],
  'security-cors': ['Security', 'CORS', 'Security'],
};
