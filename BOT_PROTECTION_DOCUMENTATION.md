# Bot Protection Detection - Complete Documentation

**Last Updated**: December 23, 2024  
**Status**: ✅ Production Ready  
**Ticket**: SITES-37727

---

## 📚 Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Implementation Details](#implementation-details)
4. [Usage Guide](#usage-guide)
5. [Configuration](#configuration)
6. [Troubleshooting](#troubleshooting)
7. [Related Documents](#related-documents)

---

## 🚀 Quick Start

### What is Bot Protection Detection?

A four-layer system that identifies when websites block SpaceCat's bot, preventing failed audits and wasted resources.

### Quick Commands

```bash
# Test a site manually
/spacecat detect-bot-blocker https://example.com

# Onboard a site (bot protection checked automatically)
/spacecat onboard site https://example.com <imsOrgId>
```

### Quick Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│   API    │───▶│ Content  │───▶│  Audit   │───▶│   Task   │
│ Service  │    │ Scraper  │    │  Worker  │    │Processor │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
   ↓ STOPS         ↓ ADDS         ↓ VALIDATES    ↓ SENDS
 Onboarding      Metadata        Scrapes       Slack Alerts
```

---

## 🏗️ Architecture Overview

### Three Detection Layers

| Layer | When | What | Action |
|-------|------|------|--------|
| **1. API Service** | During onboarding | Tests 5 URLs for bot protection | **STOPS** onboarding if detected |
| **2. Content Scraper** | During audits | Analyzes each scraped URL | **ADDS** metadata to results |
| **3. Task Processor** | After audits | Reads scrape metadata | **SENDS** Slack alerts |

### Flow Diagram

See: [`BOT_DETECTION_ARCHITECTURE.mmd`](./BOT_DETECTION_ARCHITECTURE.mmd)

Use https://mermaid.live/ to visualize the complete flow diagram.

---

## 🔧 Implementation Details

### 1. API Service - Early Detection

**File**: `spacecat-api-service/src/support/utils/bot-protection-check.js`

**Purpose**: Detect bot protection during onboarding to prevent wasted resources

**How it works**:
1. Tests **5 URLs** when site is onboarded:
   - Homepage
   - `/robots.txt`
   - `/sitemap.xml`
   - `/en/` (optional locale)
   - `/fr/` (optional locale)

2. Detects:
   - HTTP/2 errors (NGHTTP2_INTERNAL_ERROR)
   - Challenge pages (Cloudflare "Just a moment...")
   - 403 Forbidden responses
   - Known bot protection headers

3. Returns confidence score (0-1):
   - **1.0 (100%)**: Definitive detection
   - **0.9 (90%)**: Very likely (HTTP/2 on critical paths)
   - **0.7 (70%)**: Moderate (HTTP/2 on optional paths)
   - **0.5 (50%)**: Uncertain
   - **0 (0%)**: No detection

4. **Stops onboarding** if:
   - `blocked === true`, OR
   - `confidence >= 0.7` AND type is NOT `-allowed`

**Key Code**:
```javascript
const shouldStopOnboarding = 
  botProtectionResult.blocked || 
  (botProtectionResult.confidence >= 0.7 && 
   !botProtectionResult.type?.includes('-allowed'));

if (shouldStopOnboarding) {
  // Send alert and stop
}
```

---

### 2. Content Scraper - Runtime Detection

**File**: `spacecat-content-scraper/src/handlers/abstract-handler.js`

**Purpose**: Detect bot protection during actual content scraping

**How it works**:
1. For each URL scraped during audits
2. Analyzes response (status, headers, HTML)
3. Adds `botProtection` metadata:
   ```json
   {
     "blocked": false,
     "type": "cloudflare-allowed",
     "confidence": 1.0,
     "crawlable": true
   }
   ```
4. Stores in scrape database for later analysis

**Key Code**:
```javascript
const botProtection = analyzeBotProtection({
  status: response.status,
  headers: response.headers,
  html: content
});

metadata.botProtection = botProtection;
```

---

### 3. Audit Worker - Validation

**Files**: 
- `spacecat-audit-worker/src/common/bot-protection-utils.js`
- `spacecat-audit-worker/src/metatags/ssr-meta-validator.js`

**Purpose**: Validate scrape results and handle bot protection during audit execution

**How it works:**
1. Provides utility functions to check scrape results
2. Throws `BotProtectionError` when bot protection blocks access
3. SSR meta validator detects bot protection on 403 responses
4. Enables audits to gracefully handle bot-protected content

**Key Functions:**

**checkBotProtectionInScrapeResult**: Checks if scrape result indicates blocking
```javascript
const botProtection = checkBotProtectionInScrapeResult(scrapeResult, log);

if (botProtection && botProtection.blocked) {
  // Handle blocking scenario
}
```

**validateScrapeForBotProtection**: Validates and throws error if blocked
```javascript
// Throws BotProtectionError if bot protection blocks scraping
validateScrapeForBotProtection(scrapeResult, url, log);
```

**SSR Meta Validator Integration:**
```javascript
if (response.status === 403) {
  const botProtection = analyzeBotProtection({
    status: response.status,
    headers: response.headers,
    html: await response.text()
  });
  
  if (!botProtection.crawlable) {
    log.error(`SSR validation blocked by ${botProtection.type}`);
  }
}
```

---

### 4. Task Processor - Alert Generation

**File**: `spacecat-task-processor/src/tasks/opportunity-status-processor/handler.js`

**Purpose**: Alert when bot protection is found in audit results

**How it works**:
1. Reads scrape results from database
2. Checks `botProtection` in metadata
3. If 50%+ URLs blocked → Send Slack alert
4. Alert includes:
   - Protection type and confidence
   - Blocked URL count (e.g., "2/3 URLs")
   - Allowlist instructions (IP addresses + User-Agent)
   - Environment-specific guidance (prod/dev)

**Key Code**:
```javascript
const blockedResults = scrapeResults.filter((result) => {
  const { botProtection } = result.metadata || {};
  return botProtection && (botProtection.blocked || !botProtection.crawlable);
});

if (blockedResults.length / scrapeResults.length >= 0.5) {
  await sendBotProtectionAlert();
}
```

---

## 📖 Usage Guide

### Slack Commands

#### 1. Detect Bot Blocker (Manual Check)

```bash
/spacecat detect-bot-blocker https://example.com
```

**Output**:
```
🤖 Bot Blocker Detection Results for https://example.com

✅ Crawlable: Yes (Infrastructure present, allowing requests)
🛡️ Blocker Type: Cloudflare (Allowed)
💪 Confidence: 100% - Very confident in detection

Details:
• HTTP Status: 200
• HTML Size: 53360 bytes
```

#### 2. Onboard Site (Automatic Check)

```bash
/spacecat onboard site https://example.com 8C6043F15F43B6390A49401A@AdobeOrg
```

**If bot protection detected**:
```
⚠️ Bot Protection Detected for https://example.com

Onboarding stopped due to the following reasons:
• SpaceCat bot cannot access the site due to bot protection
• Scraper would receive challenge pages instead of real content
• Audits cannot be generated without site access

Action Required:
Customer must allowlist SpaceCat in their bot protection configuration

User-Agent to allowlist:
SpaceCat/1.0 (compatible; Adobe Experience Cloud; +https://adobe.com)

Development IPs to allowlist:
• 3.133.15.196
• 18.188.179.105

After allowlisting, re-run the onboard command to complete onboarding.
```

---

### Bot Protection Types

| Type | Meaning | Onboarding | Example |
|------|---------|-----------|---------|
| `cloudflare` | Cloudflare blocking | 🛑 Stops | Challenge page returned |
| `cloudflare-allowed` | Cloudflare present, allowing | ✅ Proceeds | zepbound.lilly.com |
| `imperva` | Imperva blocking | 🛑 Stops | Incapsula challenge |
| `imperva-allowed` | Imperva present, allowing | ✅ Proceeds | - |
| `akamai` | Akamai Bot Manager blocking | 🛑 Stops | Bot Manager challenge |
| `akamai-allowed` | Akamai present, allowing | ✅ Proceeds | - |
| `http2-block` | HTTP/2 stream errors | 🛑 Stops | bmw.fr |
| `http-error` | 403/401 errors | 🛑 Stops | Direct access denied |
| `none` | No protection found | ✅ Proceeds | adobe.com |
| `unknown` | Unidentified issue | ⚠️ Depends on confidence | - |

---

### Confidence Levels

| Confidence | Meaning | Action |
|-----------|---------|--------|
| **100%** | Definitive detection | Stop if blocking, proceed if allowed |
| **90%** | Very likely (HTTP/2 on critical paths) | Stop |
| **70%** | Moderate (HTTP/2 on optional paths) | Stop |
| **50%** | Uncertain | Proceed (fail open) |
| **0%** | Unknown/No detection | Proceed |

**Decision Logic**:
```
IF blocked === true:
    STOP onboarding
ELSE IF confidence >= 70% AND type does NOT contain "-allowed":
    STOP onboarding
ELSE:
    PROCEED with onboarding
```

---

## ⚙️ Configuration

### Environment Variables

```bash
# User-Agent for all SpaceCat requests
SPACECAT_BOT_USER_AGENT="SpaceCat/1.0 (compatible; Adobe Experience Cloud; +https://adobe.com)"

# Production IPs (allowlist these)
SPACECAT_BOT_IPS_PRODUCTION="18.209.226.45,54.147.28.109,44.194.103.150"

# Development IPs (allowlist these)
SPACECAT_BOT_IPS_DEVELOPMENT="3.133.15.196,18.188.179.105"

# AWS Region (determines which IPs to show in messages)
AWS_REGION="us-east-1"  # prod
AWS_REGION="us-west-2"  # dev
```

### Confidence Threshold

Set in `onboard-modal.js`:
```javascript
const CONFIDENCE_THRESHOLD = 0.7;  // 70%
```

To change the threshold, update this constant and redeploy.

---

## 🔍 Real-World Examples

### Example 1: Cloudflare Allowed (zepbound.lilly.com)

**Scenario**: Cloudflare is present but allowing SpaceCat

**Detection Result**:
```json
{
  "blocked": false,
  "type": "cloudflare-allowed",
  "confidence": 1.0,
  "reason": "Cloudflare detected but allowing requests",
  "details": {
    "httpStatus": 200,
    "htmlSize": 53360
  }
}
```

**Outcome**: ✅ Onboarding proceeds

**Slack Message**:
```
ℹ️ Bot Protection Infrastructure Detected

Site: https://zepbound.lilly.com
Protection Type: cloudflare-allowed
Confidence: 100%

Current Status:
• SpaceCat can currently access the site
• Bot protection infrastructure is present but allowing requests
• This suggests AWS Lambda IPs may be allowlisted

Important Notes:
• If audits fail or return incorrect results, verify allowlist configuration
• Ensure allowlist is permanent and covers all required IPs
```

---

### Example 2: HTTP/2 Blocking (bmw.fr)

**Scenario**: Site blocks HTTP/2 requests on locale paths

**Detection Result**:
```json
{
  "blocked": true,
  "type": "http2-block",
  "confidence": 0.7,
  "reason": "HTTP/2 errors on locale paths (locale-en, locale-fr)",
  "details": {
    "failedRequests": [
      {
        "name": "locale-en",
        "url": "https://bmw.fr/en/",
        "error": "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
        "code": "NGHTTP2_INTERNAL_ERROR"
      },
      {
        "name": "locale-fr",
        "url": "https://bmw.fr/fr/",
        "error": "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
        "code": "NGHTTP2_INTERNAL_ERROR"
      }
    ]
  }
}
```

**Outcome**: 🛑 Onboarding stopped

**Slack Messages**:
```
:x: Error detecting locale for site https://bmw.fr: Stream closed with error code NGHTTP2_INTERNAL_ERROR

:warning: Bot protection detected during onboarding process
HTTP/2 connection errors indicate the site is blocking automated requests. Please allowlist SpaceCat bot before onboarding.

:x: Failed to start onboarding for site https://bmw.fr: Bot protection detected: Stream closed with error code NGHTTP2_INTERNAL_ERROR
```

---

### Example 3: Cloudflare Challenge (Blocked)

**Scenario**: Cloudflare returns challenge page despite 200 OK

**Detection Result**:
```json
{
  "blocked": true,
  "type": "cloudflare",
  "confidence": 0.95,
  "reason": "Challenge page detected despite 200 status",
  "details": {
    "httpStatus": 200,
    "htmlSize": 5234
  }
}
```

**Outcome**: 🛑 Onboarding stopped

**HTML Detected**:
```html
<title>Just a moment...</title>
<div class="cf-chl-widget">...</div>
```

---

## 🐛 Troubleshooting

### Problem: False Positives

**Symptom**: Site is accessible but onboarding stops

**Possible Causes**:
1. Temporary network issues mistaken for blocking
2. Site has intermittent bot protection
3. Geographic restrictions (site blocks from AWS regions)

**Solutions**:
1. Retry onboarding after a few minutes
2. Check if site works from browser in same AWS region
3. Manually verify with `/spacecat detect-bot-blocker`
4. Lower confidence threshold temporarily (code change required)

---

### Problem: False Negatives

**Symptom**: Onboarding succeeds but audits fail

**Possible Causes**:
1. Bot protection triggers after multiple requests
2. Session-based blocking (blocks after initial requests)
3. JavaScript-required challenges (not detected by our checks)
4. Rate limiting (gradual blocking)

**Solutions**:
1. Check scrape database for bot protection metadata
2. Look for patterns in failed audit URLs
3. Check task processor logs for bot protection alerts
4. Consider implementing headless browser checks

---

### Problem: Allowed Infrastructure Not Detected

**Symptom**: Warning not shown for allowed Cloudflare/etc

**Possible Causes**:
1. Headers not present in response
2. HTML doesn't contain expected markers
3. Infrastructure using non-standard configuration

**Solutions**:
1. Check response headers manually: `curl -I https://example.com`
2. Verify HTML contains expected attributes
3. Add new detection patterns to `spacecat-shared-utils`

---

### Problem: HTTP/2 Errors on Clean Sites

**Symptom**: False HTTP/2 errors on sites without bot protection

**Possible Causes**:
1. Network instability
2. Server-side HTTP/2 issues
3. SSL/TLS certificate problems

**Solutions**:
1. Retry the check
2. Test from different location/network
3. Check server logs if accessible
4. Report to site owner

---

## 📊 Monitoring & Metrics

### Key Metrics to Track

1. **Onboarding Stop Rate**
   - Target: <10% of onboarding attempts
   - Alert if: >20% of attempts stopped

2. **False Positive Rate**
   - Target: <5%
   - Measure: Sites stopped but later found to be accessible

3. **False Negative Rate**
   - Target: <10%
   - Measure: Sites onboarded but audits fail due to bot protection

4. **Alert Delivery Time**
   - Target: <5 minutes from detection
   - Measure: Time from scrape to Slack message

5. **Coverage**
   - Target: >80% of bot-protected sites detected
   - Measure: Manual review of failed audits

### Where to Check

**CloudWatch Logs**:
```bash
# API Service
Filter pattern: "Bot protection detected"
Log group: /aws/lambda/spacecat-api-service

# Content Scraper
Filter pattern: "botProtection"
Log group: /aws/lambda/spacecat-content-scraper

# Task Processor
Filter pattern: "Bot protection blocking scrapes"
Log group: /aws/lambda/spacecat-task-processor
```

**Database Queries**:
```sql
-- Count bot protection detections
SELECT 
  metadata->>'botProtection'->>'type' as type,
  COUNT(*) as count
FROM scrape_results
WHERE metadata->>'botProtection' IS NOT NULL
GROUP BY type;

-- Find sites with bot protection
SELECT DISTINCT site_id
FROM scrape_results
WHERE metadata->>'botProtection'->>'blocked' = 'true';
```

---

## 🧪 Testing

### Manual Testing

```bash
# Test sites with known bot protection
/spacecat detect-bot-blocker https://bmw.fr
/spacecat detect-bot-blocker https://zepbound.lilly.com

# Test clean sites
/spacecat detect-bot-blocker https://adobe.com

# Test onboarding flow
/spacecat onboard site https://test-site.com <imsOrgId>
```

### Automated Testing

```bash
# Run all tests
cd spacecat-api-service && npm test
cd spacecat-content-scraper && npm test
cd spacecat-audit-worker && npm test
cd spacecat-task-processor && npm test

# Run with coverage
npm test -- --coverage

# Run specific test suite
npm test test/support/utils/bot-protection-check.test.js
```

See: [`BOT_PROTECTION_TEST_SUMMARY.md`](./BOT_PROTECTION_TEST_SUMMARY.md) for detailed test documentation.

---

## 📝 Related Documents

- **Implementation Summary**: [`BOT_PROTECTION_IMPLEMENTATION_SUMMARY.md`](./BOT_PROTECTION_IMPLEMENTATION_SUMMARY.md)
- **Test Summary**: [`BOT_PROTECTION_TEST_SUMMARY.md`](./BOT_PROTECTION_TEST_SUMMARY.md)
- **Architecture Diagram**: [`BOT_DETECTION_ARCHITECTURE.mmd`](./BOT_DETECTION_ARCHITECTURE.mmd)

---

## 🔗 Code References

### API Service
- Bot protection check: `src/support/utils/bot-protection-check.js`
- Onboard modal integration: `src/support/slack/actions/onboard-modal.js`
- Slack command: `src/support/slack/commands/detect-bot-blocker.js`
- Slack messaging: `src/support/slack/actions/commons.js`
- Utils integration: `src/support/utils.js`

### Content Scraper
- Handler integration: `src/handlers/abstract-handler.js`

### Audit Worker
- Bot protection utils: `src/common/bot-protection-utils.js`
- SSR meta validator: `src/metatags/ssr-meta-validator.js`

### Task Processor
- Status processor: `src/tasks/opportunity-status-processor/handler.js`
- Slack utils: `src/utils/slack-utils.js`

### Shared Utils
- Detection logic: `packages/spacecat-shared-utils/src/bot-blocker-detect/bot-blocker-detect.js`
- Constants: `packages/spacecat-shared-utils/src/index.js`

---

## 📞 Support

**Questions?** 
- Check this documentation first
- Review test files for examples
- Check CloudWatch logs for runtime behavior

**Issues?**
- Create ticket in SpaceCat project
- Add label: `bot-protection`
- Include: Site URL, error messages, logs

**Feature Requests?**
- Discuss with SpaceCat team
- Consider impact on performance
- Ensure backward compatibility

---

## 🎓 Best Practices

### For Site Owners

1. **Allowlist SpaceCat User-Agent**:
   ```
   SpaceCat/1.0 (compatible; Adobe Experience Cloud; +https://adobe.com)
   ```

2. **Allowlist IP Addresses**:
   - Production: See environment variables above
   - Development: See environment variables above

3. **Configure Bot Protection**:
   - Allow automated requests from SpaceCat
   - Don't block based on request frequency alone
   - Consider rate limiting instead of hard blocking

### For Developers

1. **Adding New Bot Protection Types**:
   - Add detection pattern to `spacecat-shared-utils`
   - Add test cases
   - Update documentation
   - Update Slack message formatting

2. **Adjusting Confidence**:
   - Be conservative (better false negatives than positives)
   - Document reasoning for confidence levels
   - Test with real-world examples

3. **Performance**:
   - Keep checks fast (<5 seconds total)
   - Use timeouts on all network requests
   - Cache results when appropriate

---

**Last Updated**: December 23, 2024  
**Version**: 1.0  
**Status**: ✅ Production Ready
