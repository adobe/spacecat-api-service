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

/**
 * Data transfer object for Marketing Channel Response.
 */
export const MarketingChannelResponseDto = {
  /**
   * Converts a marketing channel data object into a JSON object.
   * @param {object} data - Marketing channel data object.
   * @returns {{
   *   type: string,
   *   channel: string,
   *   platform: string,
   *   campaign: string,
   *   pageviews: number,
   *   pct_pageviews: number,
   *   click_rate: number,
   *   engagement: number,
   *   bounce_rate: number,
   *   p70_lcp: number,
   *   p70_cls: number,
   *   p70_inp: number
   * }} JSON object.
   */
  toJSON: (data) => ({
    type: data.type,
    channel: data.channel,
    platform: data.platform,
    campaign: data.campaign,
    pageviews: data.pageviews,
    pct_pageviews: data.pct_pageviews,
    click_rate: data.click_rate,
    engagement: data.engagement_rate,
    bounce_rate: data.bounce_rate,
    p70_lcp: data.p70_lcp,
    p70_cls: data.p70_cls,
    p70_inp: data.p70_inp,
  }),
};
