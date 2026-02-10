#!/usr/bin/env node

/* eslint-disable */

import fs from "fs";
import { parse } from "csv-parse/sync";
import { createObjectCsvWriter } from "csv-writer";
import * as Diff from "diff";

// ---------- CLI ----------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : def;
}

const metaPath = "./scripts/times.csv"
const htmlPath = "./scripts/htmls.csv"
const outPath = arg("out", "./scripts/final_diffs.csv");

// Column names (override if needed)
const metaUrlCol = arg("metaUrlCol", "url");
const metaLastModCol = arg("metaLastModCol", "last_modified_values");
const metaReqCol = arg("metaReqCol", "request_id_values");

const htmlReqCol = arg("htmlReqCol", "request_id");
const htmlUrlCol = arg("htmlUrlCol", "url");
const htmlCol = arg("htmlCol", "html");

// ---------- helpers ----------
function readCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

function splitMulti(v) {
  if (v == null) return [];
  const s = String(v).trim();
  if (!s) return [];
  
  // Check for literal "\n" (backslash-n) from CSV parsing that escaped actual newlines
  // This appears as the literal two-character string in the CSV
  if (s.includes(" \\n ")) {
    return s.split(/\s*\\n\s*/).map(x => x.trim()).filter(Boolean);
  }
  
  // If you exported with Splunk multivalue -> actual newlines inside a cell
  if (s.includes("\n")) return s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  
  // Check for multiple space-separated UUIDs (like request IDs)
  // Only split on spaces if there are no commas (commas indicate it's a date string)
  if (s.includes(" ") && !s.includes(",")) return s.split(/\s+/).map(x => x.trim()).filter(Boolean);
  
  // Fallback: if it is a single value
  return [s];
}

function parseRfc1123ToEpoch(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function normalizeHtml(html) {
  if (html == null) return "";
  let s = String(html);
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  return s;
}

function isUsefulChange(text) {
  // Filter out purely technical/styling changes
  const skipPatterns = [
    /^<style[\s\S]*?<\/style>$/i,  // CSS blocks
    /^<script[\s\S]*?<\/script>$/i, // Script blocks
    /^@font-face\{/i,               // Font definitions
    /^:root\{/,                     // CSS variables
    /^<link\s+rel=/i,               // Link tags
    /^<meta\s+name="viewport"/i,    // Viewport meta
    /^<meta\s+name="theme-color"/i, // Theme color
    /^data:font\//,                 // Base64 fonts
    /^data:image\//,                // Base64 images
    /^url\(data:/,                  // Data URLs
    /^\{["\s]*@context/,            // JSON-LD schema boilerplate
    /^amp-/i,                       // AMP tags
    /^\[class\^=/,                  // CSS selectors
    /^src="https:\/\/.*\.js"/,      // Script sources
    /^href="https:\/\/.*\.css"/,    // Stylesheet links
  ];
  
  return !skipPatterns.some(pattern => pattern.test(text));
}

function diffLines(oldText, newText, maxChanges = 20, maxChunkLen = 200) {
  // Use word-level diff to catch actual content changes
  const parts = Diff.diffWords(oldText, newText);
  
  let addedChunks = [];
  let removedChunks = [];
  let addedWordCount = 0;
  let removedWordCount = 0;
  
  for (const p of parts) {
    const chunk = p.value.trim();
    if (!chunk) continue;
    
    // Skip purely technical changes
    if (!isUsefulChange(chunk)) continue;
    
    const words = chunk.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    
    if (p.added) {
      addedWordCount += wordCount;
      if (addedChunks.length < maxChanges) {
        let displayChunk = chunk;
        if (displayChunk.length > maxChunkLen) {
          displayChunk = displayChunk.slice(0, maxChunkLen) + "...";
        }
        addedChunks.push(displayChunk);
      }
    }
    if (p.removed) {
      removedWordCount += wordCount;
      if (removedChunks.length < maxChanges) {
        let displayChunk = chunk;
        if (displayChunk.length > maxChunkLen) {
          displayChunk = displayChunk.slice(0, maxChunkLen) + "...";
        }
        removedChunks.push(displayChunk);
      }
    }
  }
  
  let added = addedWordCount > 0 
    ? `[${addedWordCount} words]\\n` + addedChunks.join("\\n---\\n")
    : "[No meaningful changes]";
    
  let removed = removedWordCount > 0
    ? `[${removedWordCount} words]\\n` + removedChunks.join("\\n---\\n")
    : "[No meaningful changes]";
  
  if (addedChunks.length > 0 && addedChunks.length < addedWordCount) {
    added += `\\n... (+${addedWordCount - addedChunks.length} more)`;
  }
  if (removedChunks.length > 0 && removedChunks.length < removedWordCount) {
    removed += `\\n... (-${removedWordCount - removedChunks.length} more)`;
  }
  
  return { added, removed };
}

// ---------- load ----------
const metaRows = readCsv(metaPath);
const htmlRows = readCsv(htmlPath);

// request_id -> { url, html }
const htmlByReq = new Map();
for (const r of htmlRows) {
  const req = String(r[htmlReqCol] ?? "").trim();
  if (!req) continue;
  const url = String(r[htmlUrlCol] ?? "").trim();
  const html = normalizeHtml(r[htmlCol] ?? "");
  // Prefer first non-empty html
  if (!htmlByReq.has(req) || (!htmlByReq.get(req).html && html)) {
    htmlByReq.set(req, { url, html });
  }
}

// Build versions per URL: [{requestId,lastMod,epoch,html}]
const versionsByUrl = new Map();

for (const r of metaRows) {
  const url = String(r[metaUrlCol] ?? "").trim();
  if (!url) continue;

  const reqs = splitMulti(r[metaReqCol]);
  const lms = splitMulti(r[metaLastModCol]);

  const n = Math.max(reqs.length, lms.length, 0);
  for (let i = 0; i < n; i++) {
    const requestId = (reqs[i] ?? reqs[0] ?? "").trim();
    const lastMod = (lms[i] ?? lms[0] ?? "").trim();
    if (!requestId) continue;

    const htmlRec = htmlByReq.get(requestId);
    const html = htmlRec ? htmlRec.html : "";

    const epoch = lastMod ? parseRfc1123ToEpoch(lastMod) : null;

    if (!versionsByUrl.has(url)) versionsByUrl.set(url, []);
    versionsByUrl.get(url).push({
      url,
      request_id: requestId,
      last_modified: lastMod,
      last_modified_epoch: epoch,
      html,
    });
  }
}

// de-dup per url+request_id
for (const [url, arr] of versionsByUrl.entries()) {
  const map = new Map();
  for (const v of arr) {
    const key = v.request_id;
    if (!map.has(key)) map.set(key, v);
    else {
      const cur = map.get(key);
      const ce = cur.last_modified_epoch ?? -1;
      const ne = v.last_modified_epoch ?? -1;
      if (ne > ce) map.set(key, v);
    }
  }
  versionsByUrl.set(url, Array.from(map.values()));
}

// ---------- compute diffs ----------
const out = [];

for (const [url, vers] of versionsByUrl.entries()) {
  vers.sort((a, b) => {
    const ae = a.last_modified_epoch;
    const be = b.last_modified_epoch;
    if (ae != null && be != null) return ae - be;
    if (ae != null) return -1;
    if (be != null) return 1;
    return (a.last_modified || "").localeCompare(b.last_modified || "");
  });

  if (vers.length < 2) {
    const only = vers[0];
    out.push({
      url,
      from_request_id: "",
      to_request_id: only?.request_id ?? "",
      from_last_modified: "",
      to_last_modified: only?.last_modified ?? "",
      added: "",
      removed: "",
      note: only?.html ? "Only one version; no diff computed" : "Only one version; HTML missing",
    });
    continue;
  }

  for (let i = 1; i < vers.length; i++) {
    const prev = vers[i - 1];
    const cur = vers[i];

    if (!prev.html || !cur.html) {
      out.push({
        url,
        from_request_id: prev.request_id,
        to_request_id: cur.request_id,
        from_last_modified: prev.last_modified,
        to_last_modified: cur.last_modified,
        added: "",
        removed: "",
        note:
          (!prev.html ? "Missing HTML for from_request_id" : "") +
          (!prev.html && !cur.html ? "; " : "") +
          (!cur.html ? "Missing HTML for to_request_id" : ""),
      });
      continue;
    }

    const { added, removed } = diffLines(prev.html, cur.html);

    out.push({
      url,
      from_request_id: prev.request_id,
      to_request_id: cur.request_id,
      from_last_modified: prev.last_modified,
      to_last_modified: cur.last_modified,
      added,
      removed,
      note: "",
    });
  }
}

// ---------- write CSV ----------
(async () => {
  // Ensure all string fields are properly cleaned
  const cleanedOut = out.map(row => ({
    url: String(row.url || ""),
    from_request_id: String(row.from_request_id || ""),
    to_request_id: String(row.to_request_id || ""),
    from_last_modified: String(row.from_last_modified || ""),
    to_last_modified: String(row.to_last_modified || ""),
    added: String(row.added || ""),
    removed: String(row.removed || ""),
    note: String(row.note || ""),
  }));

  const writer = createObjectCsvWriter({
    path: outPath,
    header: [
      { id: "url", title: "url" },
      { id: "from_request_id", title: "from_request_id" },
      { id: "to_request_id", title: "to_request_id" },
      { id: "from_last_modified", title: "from_last_modified" },
      { id: "to_last_modified", title: "to_last_modified" },
      { id: "added", title: "added" },
      { id: "removed", title: "removed" },
      { id: "note", title: "note" },
    ],
    alwaysQuote: true,
  });

  await writer.writeRecords(cleanedOut);
  console.log(`Wrote ${cleanedOut.length} rows to ${outPath}`);
})();
