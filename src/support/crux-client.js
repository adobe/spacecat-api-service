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
/* c8 ignore start */

const FORM_FACTORS = {
  desktop: 'DESKTOP',
  mobile: 'PHONE',
  tablet: 'TABLET',
};

const CRUX_API_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

export async function fetchCruxData(params) {
  if (!params.apiKey) {
    throw new Error('API key is required');
  }

  if (!FORM_FACTORS[params.formFactor]) {
    throw new Error(`Invalid form factor: ${params.formFactor}`);
  }
  const requestBody = {
    formFactor: FORM_FACTORS[params.formFactor],
  };

  if (!params.origin && !params.url) {
    throw new Error('Either origin or url must be provided');
  } else if (params.origin && params.url) {
    throw new Error('Only one of origin or url can be provided');
  } else if (params.origin) {
    requestBody.origin = params.origin;
  } else {
    requestBody.url = params.url;
  }

  const response = await fetch(`${CRUX_API_URL}?key=${params.apiKey}`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch CRUX data: ${response.statusText}`);
  }

  const json = await response.json();
  return json.record;
}
/* c8 ignore end */
