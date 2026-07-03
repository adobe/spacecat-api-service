/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/*
 * Adapts the agent's free-text brief into the shape the Elmo UI already renders
 * (briefSlides / briefSections in project-elmo-ui's MarketingConsultantDataset).
 *
 * POC: the agent returns short markdown-ish prose. We surface it verbatim as one
 * BriefSection and derive a single summary BriefSlide from its lines. A production
 * adapter would ask the agent for structured JSON and map fields 1:1.
 */

/**
 * @param {string} text - raw brief text returned by the agent
 * @returns {{ briefSlides: object[], briefSections: object[] }}
 */
export function adaptBriefText(text) {
  const clean = (text || '').trim();

  const bullets = clean
    .split('\n')
    .map((line) => line.replace(/^[\s#*\-\d.)]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);

  const briefSlides = [
    {
      id: 'agent-brief',
      title: 'Adobe Marketing Agent',
      subtitle: 'Live-generated GEO brief',
      highlight: 'Generated from your data sources',
      bullets: bullets.length > 0 ? bullets : ['No content returned by the agent.'],
    },
  ];

  const briefSections = [
    {
      id: 'agent-brief',
      title: 'AI-generated strategic brief',
      contentMarkdown: clean || '_No content returned by the agent._',
    },
  ];

  return { briefSlides, briefSections };
}

/**
 * Adapts the CoWorker FULL brief (structured JSON: { executiveSummary, kpis[], considerations[] })
 * into the rich UI shape — briefSlides (the 6 considerations), geoKpis, and briefSections
 * (executive summary + a KPI table). Falls back to plain-text adaptation if JSON is missing.
 * @param {string} text - raw agent response (expected JSON)
 * @returns {{ briefSlides: object[], briefSections: object[], geoKpis: object[] }}
 */
export function adaptFullBrief(text) {
  const clean = (text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { ...adaptBriefText(text), geoKpis: [] };
  }

  if (!parsed || !Array.isArray(parsed.considerations)) {
    return { ...adaptBriefText(text), geoKpis: [] };
  }

  const briefSlides = parsed.considerations.slice(0, 6).map((c, i) => ({
    id: `consideration-${i + 1}`,
    title: String(c?.title || `Consideration ${i + 1}`),
    subtitle: 'Adobe CoWorker',
    bullets: Array.isArray(c?.bullets) ? c.bullets.map(String) : [],
  }));

  const geoKpis = Array.isArray(parsed.kpis)
    ? parsed.kpis.slice(0, 6).map((k) => ({
      label: String(k?.label || ''),
      score: Number(k?.score) || 0,
      rank: Number(k?.rank) || 0,
      totalBrands: Number(k?.totalBrands) || 0,
      benchmarkDelta: String(k?.benchmarkDelta || ''),
    }))
    : [];

  const briefSections = [];
  if (parsed.executiveSummary) {
    briefSections.push({
      id: 'exec-summary',
      title: 'Executive summary',
      contentMarkdown: String(parsed.executiveSummary),
    });
  }
  if (geoKpis.length > 0) {
    const rows = geoKpis
      .map((k) => `| ${k.label} | ${k.score} | ${k.rank}/${k.totalBrands} | ${k.benchmarkDelta} |`)
      .join('\n');
    briefSections.push({
      id: 'geo-kpis',
      title: 'Core GEO KPIs',
      contentMarkdown: `| KPI | Score | Rank | Insight |\n|---|---|---|---|\n${rows}`,
    });
  }

  return { briefSlides, briefSections, geoKpis };
}
