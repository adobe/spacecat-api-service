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

/* eslint-disable camelcase */
import { TrafficDataResponseDto } from './traffic-data-base-response.js';

const DEFAULT_THRESHOLDS = {
  LCP_GOOD: 2500,
  LCP_NEEDS_IMPROVEMENT: 4000,
  INP_GOOD: 200,
  INP_NEEDS_IMPROVEMENT: 500,
  CLS_GOOD: 0.1,
  CLS_NEEDS_IMPROVEMENT: 0.25,
};

function getThreshold(key, config) {
  return key in config ? config[key] : DEFAULT_THRESHOLDS[key];
}

function scoreCWV(metric, val, config) {
  const GOOD = getThreshold(`${metric}_GOOD`, config);
  const NEEDS_IMPROVEMENT = getThreshold(`${metric}_NEEDS_IMPROVEMENT`, config);

  if (val <= GOOD) return 'good';
  if (val <= NEEDS_IMPROVEMENT) return 'needs improvement';
  return 'poor';
}

/**
 * Converts marketing traffic data into enriched DTO with CWV scores.
 */
export const TrafficDataWithCWVDto = {
  /**
   * @param {object} data - Raw data input.
   * @param {object} [thresholdConfig] - Optional override for CWV thresholds.
   * @returns {{
   *   type: string,
   *   channel: string,
   *   campaign: string,
   *   pageviews: number,
   *   pct_pageviews: number,
   *   click_rate: number,
   *   engagement_rate: number,
   *   bounce_rate: number,
   *   p70_lcp: number,
   *   p70_cls: number,
   *   p70_inp: number,
   *   lcp_score: string,
   *   inp_score: string,
   *   cls_score: string,
   *   overall_cwv_score: string,
   * }} JSON object.
     */
  toJSON: (data, thresholdConfig, baseUrl) => {
    const lcp = Number(data.p70_lcp);
    const inp = Number(data.p70_inp);
    const cls = Number(data.p70_cls);

    const lcp_score = scoreCWV('LCP', lcp, thresholdConfig);
    const inp_score = scoreCWV('INP', inp, thresholdConfig);
    const cls_score = scoreCWV('CLS', cls, thresholdConfig);

    const scores = [lcp_score, inp_score, cls_score];
    let overall_cwv_score;
    if (scores.includes('poor')) {
      overall_cwv_score = 'poor';
    } else if (scores.includes('needs improvement')) {
      overall_cwv_score = 'needs improvement';
    } else {
      overall_cwv_score = 'good';
    }

    return {
      ...TrafficDataResponseDto.toJSON(data),
      url: data.url || (baseUrl && data.path ? `${baseUrl.replace(/\/$/, '')}/${data.path.replace(/^\//, '')}` : undefined),
      path: data.path,
      page_type: data.page_type,
      device: data.device,
      p70_lcp: lcp,
      p70_cls: cls,
      p70_inp: inp,
      lcp_score,
      inp_score,
      cls_score,
      overall_cwv_score,
    };
  },
};
