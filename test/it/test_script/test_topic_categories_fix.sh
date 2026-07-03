#!/bin/bash
# =============================================================================
# Test Plan: topic_categories junction (extended for PR #2304 / LLMO-4623 —
# surfacing categoryUuids on the topics list response). Original junction
# write-side fix shipped in PR #2195.
#
# Validates that POST /v2/orgs/:orgId/topics correctly creates a
# topic_categories junction row when categoryId is provided, and that
# GET /v2/orgs/:orgId/topics surfaces the linked category UUIDs.
#
# Tests:
#   1. Category creation
#   2. Topic with categoryId → junction linked (verified via topics list,
#      including categoryUuids contains the linked UUID — LLMO-4623)
#   3. Topic without categoryId → no regression (categoryUuids = [])
#   4. Idempotency → duplicate POST returns same topic UUID
#   5. Invalid categoryId → topic still created (graceful failure)
#   6. Cleanup
#
# Usage:
#   SESSION_TOKEN=<jwt> ./test_topic_categories_fix.sh
#   API_KEY=<key> ./test_topic_categories_fix.sh
#   SESSION_TOKEN=<jwt> ENV=prod ./test_topic_categories_fix.sh
#
# Requirements: curl, jq
# =============================================================================
set -euo pipefail

# --- CONFIG ---
ENV="${ENV:-dev}"
if [ "$ENV" = "prod" ]; then
  BASE_URL="https://spacecat.experiencecloud.live/api/v1"
else
  BASE_URL="https://spacecat.experiencecloud.live/api/ci"
fi

API_KEY="${API_KEY:-}"
SESSION_TOKEN="${SESSION_TOKEN:-}"
# AE-ASSETS-ENG dev org (default dev test org)
ORG_ID="${ORG_ID:-2004b7e5-d5e7-4b98-8961-7005a948332d}"

# --- VALIDATION ---
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi
if [ -z "$API_KEY" ] && [ -z "$SESSION_TOKEN" ]; then
  echo "Error: API_KEY or SESSION_TOKEN is required"
  echo "Usage: SESSION_TOKEN=<jwt> $0"
  exit 1
fi

if [ -n "$SESSION_TOKEN" ]; then
  AUTH_HEADER="Authorization: Bearer $SESSION_TOKEN"
else
  AUTH_HEADER="x-api-key: $API_KEY"
fi

# --- HELPERS ---
PASS=0
FAIL=0
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# macOS-compatible: write body to tmp file, return status code
req() {
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -s -o "$TMP" -w "%{http_code}" -X "$method" "$url" \
      -H "$AUTH_HEADER" -H "Content-Type: application/json" -d "$data"
  else
    curl -s -o "$TMP" -w "%{http_code}" -X "$method" "$url" \
      -H "$AUTH_HEADER"
  fi
}

body() { cat "$TMP"; }

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
    echo "  Response: $(cat "$TMP")"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_not_empty() {
  local label="$1" value="$2"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    pass "$label"
  else
    fail "$label — value is empty or null"
  fi
}

echo ""
echo "======================================================================"
echo " Topic Categories Fix — Test Plan"
echo " ENV:    $ENV"
echo " URL:    $BASE_URL"
echo " ORG_ID: $ORG_ID"
echo "======================================================================"

TS=$(date +%s)
CATEGORY_SLUG="test-fix-$TS"
CATEGORY_NAME="Fix Validation Category $TS"
TOPIC_NAME="Fix Validation Topic $TS"

# =============================================================================
echo ""
echo "--- Test 1: Create category ---"
# =============================================================================
STATUS=$(req POST "$BASE_URL/v2/orgs/$ORG_ID/categories" \
  "{\"id\": \"$CATEGORY_SLUG\", \"name\": \"$CATEGORY_NAME\", \"origin\": \"human\"}")
assert_status "POST /categories" "201" "$STATUS"
CATEGORY_UUID=$(body | jq -r '.uuid // empty')
assert_not_empty "Category UUID returned" "$CATEGORY_UUID"
echo "  Category UUID: $CATEGORY_UUID"

if [ -z "$CATEGORY_UUID" ] || [ "$CATEGORY_UUID" = "null" ]; then
  echo "  ⚠️  Category creation failed — skipping Tests 2 and 4 (junction cannot be tested)"
  CATEGORY_UUID="SKIP"
fi

# =============================================================================
echo ""
echo "--- Test 2: Create topic WITH categoryId (core fix) ---"
# =============================================================================
if [ "$CATEGORY_UUID" = "SKIP" ]; then
  fail "POST /topics with categoryId — skipped (category creation failed)"
  TOPIC_UUID=""
  TOPIC_SLUG=""
else
STATUS=$(req POST "$BASE_URL/v2/orgs/$ORG_ID/topics" \
  "{\"name\": \"$TOPIC_NAME\", \"categoryId\": \"$CATEGORY_UUID\"}")
assert_status "POST /topics with categoryId" "201" "$STATUS"
TOPIC_UUID=$(body | jq -r '.uuid // empty')
TOPIC_SLUG=$(body | jq -r '.id // empty')
assert_not_empty "Topic UUID returned" "$TOPIC_UUID"
echo "  Topic UUID: $TOPIC_UUID"
echo "  Topic slug: $TOPIC_SLUG"

# Verify topic appears in list
STATUS=$(req GET "$BASE_URL/v2/orgs/$ORG_ID/topics")
LIST_BODY=$(body)
TOPIC_IN_LIST=$(echo "$LIST_BODY" | jq -r --arg uuid "$TOPIC_UUID" \
  '[(.topics // .) | .[] | select(.uuid == $uuid)] | length')
assert_eq "Topic appears in GET /topics list" "1" "$TOPIC_IN_LIST"

# Verify categoryUuids is populated in GET /topics response (LLMO-4623)
CAT_UUIDS_LEN=$(echo "$LIST_BODY" | jq -r --arg uuid "$TOPIC_UUID" --arg cat "$CATEGORY_UUID" \
  '[(.topics // .) | .[] | select(.uuid == $uuid) | .categoryUuids // [] | map(select(. == $cat))] | flatten | length')
assert_eq "categoryUuids contains linked category UUID in GET /topics" "1" "$CAT_UUIDS_LEN"

CAT_UUIDS_TYPE=$(echo "$LIST_BODY" | jq -r --arg uuid "$TOPIC_UUID" \
  '(.topics // .) | .[] | select(.uuid == $uuid) | .categoryUuids | type')
assert_eq "categoryUuids is an array type" "array" "$CAT_UUIDS_TYPE"
fi  # end CATEGORY_UUID != SKIP

# =============================================================================
echo ""
echo "--- Test 3: Create topic WITHOUT categoryId (no regression) ---"
# =============================================================================
STATUS=$(req POST "$BASE_URL/v2/orgs/$ORG_ID/topics" \
  "{\"name\": \"Standalone Topic $(date +%s)\"}")
assert_status "POST /topics without categoryId" "201" "$STATUS"
NO_CAT_UUID=$(body | jq -r '.uuid // empty')
assert_not_empty "Standalone topic UUID returned" "$NO_CAT_UUID"
echo "  Standalone topic UUID: $NO_CAT_UUID"

# Verify categoryUuids is empty for uncategorized topic (LLMO-4623)
STATUS=$(req GET "$BASE_URL/v2/orgs/$ORG_ID/topics")
NO_CAT_UUIDS_LEN=$(body | jq -r --arg uuid "$NO_CAT_UUID" \
  '(.topics // .) | .[] | select(.uuid == $uuid) | .categoryUuids | length')
assert_eq "categoryUuids is empty for uncategorized topic" "0" "$NO_CAT_UUIDS_LEN"

# =============================================================================
echo ""
echo "--- Test 4: Idempotency — duplicate POST returns same UUID ---"
# =============================================================================
if [ "$CATEGORY_UUID" = "SKIP" ] || [ -z "$TOPIC_UUID" ]; then
  fail "Idempotency — skipped (category creation failed)"
else
  STATUS=$(req POST "$BASE_URL/v2/orgs/$ORG_ID/topics" \
    "{\"name\": \"$TOPIC_NAME\", \"categoryId\": \"$CATEGORY_UUID\"}")
  assert_status "Duplicate POST /topics" "201" "$STATUS"
  DUP_UUID=$(body | jq -r '.uuid // empty')
  assert_eq "Same UUID returned (upsert idempotent)" "$TOPIC_UUID" "$DUP_UUID"
fi

# =============================================================================
echo ""
echo "--- Test 5: Invalid categoryId — topic created, graceful failure ---"
# =============================================================================
STATUS=$(req POST "$BASE_URL/v2/orgs/$ORG_ID/topics" \
  "{\"name\": \"Bad Category Topic $(date +%s)\", \"categoryId\": \"00000000-0000-0000-0000-000000000000\"}")
assert_status "POST /topics with invalid categoryId returns 201" "201" "$STATUS"
BAD_UUID=$(body | jq -r '.uuid // empty')
assert_not_empty "Topic UUID returned despite bad categoryId" "$BAD_UUID"
echo "  ℹ️  Check CloudWatch for: 'Failed to link topic $BAD_UUID to category 00000000-...'"

# =============================================================================
echo ""
echo "--- Test 6: Cleanup ---"
# =============================================================================
ST=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
  "$BASE_URL/v2/orgs/$ORG_ID/topics/$TOPIC_SLUG" -H "$AUTH_HEADER")
echo "  DELETE topics/$TOPIC_SLUG → HTTP $ST"

ST=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
  "$BASE_URL/v2/orgs/$ORG_ID/categories/$CATEGORY_SLUG" -H "$AUTH_HEADER")
echo "  DELETE categories/$CATEGORY_SLUG → HTTP $ST"

# =============================================================================
echo ""
echo "======================================================================"
echo " Results: $PASS passed, $FAIL failed"
echo "======================================================================"
if [ "$FAIL" -gt 0 ]; then
  echo " ❌ FAILED"
  exit 1
else
  echo " ✅ ALL PASSED"
fi
