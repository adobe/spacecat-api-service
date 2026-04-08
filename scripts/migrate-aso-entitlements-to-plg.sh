#!/usr/bin/env bash
# =============================================================================
# migrate-aso-entitlements-to-plg.sh
#
# Migrates ASO entitlements to PRE_ONBOARD tier using a pre-built org snapshot from
# fetch-orgs-snapshot.sh as input.
#
# Rules (applied per org in the snapshot):
#   1. Org has an ASO entitlement with FREE_TRIAL tier
#      → delete its site enrollments, then update tier to PRE_ONBOARD
#   2. Org has NO ASO entitlement
#      → create a new ASO entitlement with PRE_ONBOARD tier
#   3. Org's imsOrgId is in EXCEPTION_IMS_ORG_IDS → skip entirely
#
# Workflow:
#   1. Run fetch-orgs-snapshot.sh to produce the input JSON snapshot
#   2. Review the snapshot
#   3. Run this script pointing INPUT_FILE at the snapshot
#
# Requirements:
#   - mysticat CLI installed and logged in (mysticat login --env <ENV>)
#   - curl, jq
#
# Usage:
#   chmod +x migrate-aso-entitlements-to-plg.sh
#   INPUT_FILE=scripts/orgs-snapshot-dev-*.json ./migrate-aso-entitlements-to-plg.sh
#   INPUT_FILE=scripts/orgs-snapshot-prod-*.json ENV=prod DRY_RUN=false ./migrate-aso-entitlements-to-plg.sh
# =============================================================================

# =============================================================================
# CONFIGURATION — edit these before running
# =============================================================================

# Target environment: "dev" | "stage" | "prod"
ENV="${ENV:-dev}"

# Path to the snapshot JSON produced by fetch-orgs-snapshot.sh
# Must be provided via env var or set here
INPUT_FILE="${INPUT_FILE:-}"

# Set to "true" to only log what would happen without making any changes
DRY_RUN="${DRY_RUN:-true}"

# IMS Org IDs to skip — safety net even if they appear in the snapshot
EXCEPTION_IMS_ORG_IDS=(
  "8C6043F15F43B6390A49401A@AdobeOrg"
  "8B6E1E49678E09490A495E25@AdobeOrg"
  "A9DB73AF5F460EE00A495FB7@AdobeOrg"
  "93AC572E5FE47A040A495C3D@AdobeOrg"
  "7AB02190639B302E0A495FA4@AdobeOrg"
  "036784BD57A8BB277F000101@AdobeOrg"
  "05791F3F677F1AE80A495CB0@AdobeOrg"
  "142C2AA163CA7D3A0A495E85@AdobeOrg"
  "223234B85278553C0A490D44@AdobeOrg"
  "009A5E09512FA5700A490D4D@AdobeOrg"
  "46D01E066502B0AC0A495F9F@AdobeOrg"
  "708E423B67F3C2050A495C27@AdobeOrg"
  "AD64216A6810A3830A495C89@AdobeOrg"
  "1D6D216A680B59D70A495E79@AdobeOrg"
  "EE9332B3547CC74E0A4C98A1@AdobeOrg"
  "4F8A1ED764EFB4CB0A495C8E@AdobeOrg"
  "86FF829657DCB10D7F000101@AdobeOrg"
  "9E1005A551ED61CA0A490D45@AdobeOrg"
  "86BD1D525E2224130A495CBB@AdobeOrg"
  "77C920686809469C0A495FE5@AdobeOrg"
  "7EF5AE375630F4CD7F000101@AdobeOrg"
  "79575F6258C1A2410A495D1A@AdobeOrg"
  "812B47145DC5A2450A495C14@AdobeOrg"
  "5A4521B65E37CAFC0A495FA6@AdobeOrg"
  "021654A663AF3D5A0A495FD4@AdobeOrg"
  "371B1E8567B71A120A495EC5@AdobeOrg"
  "61F31DEE6516DB040A495FF5@AdobeOrg"
  "60B81EF86516D7410A495C57@AdobeOrg"
  "353078A25DA83E030A495C21@AdobeOrg"
  "0B96B03459707BE40A495C70@AdobeOrg"
  "6EF5A3F558F47EAC0A495D39@AdobeOrg"
  "E71EADC8584130D00A495EBD@AdobeOrg"
  "118765E655DEE7427F000101@AdobeOrg"
  "22951DFC64CBD4BA0A495C70@AdobeOrg"
  "234304B15ED9FB3C0A495C3D@AdobeOrg"
  "907136ED5D35CBF50A495CD4@AdobeOrg"
  "222571A9619E47B50A495CCE@AdobeOrg"
  "0DC5A26A5AC20D8C0A495ECD@AdobeOrg"
  "73982766645509A90A495CF5@AdobeOrg"
  "CF091EDD6477355D0A495EBD@AdobeOrg"
  "B50150D5BFBFAF000A495E31@AdobeOrg"
  "19373ED16166D21C0A495FC6@AdobeOrg"
  "14250A1662D799110A495FC0@AdobeOrg"
  "3E692814636C53B60A495EC3@AdobeOrg"
  "18B24A6D632334490A495F99@AdobeOrg"
  "2CA24CCE5D35BD4A0A495CC7@AdobeOrg"
  "908936ED5D35CC220A495CD4@AdobeOrg"
)

# =============================================================================
# DERIVED CONFIGURATION — do not edit below unless you know what you're doing
# =============================================================================

case "$ENV" in
  dev)
    POSTGREST_URL="https://dql63ofcyt4dr.cloudfront.net"
    ;;
  stage)
    POSTGREST_URL="https://d1qa2q01hboz63.cloudfront.net"
    ;;
  prod)
    POSTGREST_URL="https://d1xldhzwm6wv00.cloudfront.net"
    ;;
  *)
    echo "[ERROR] Unknown environment: '$ENV'. Must be dev, stage, or prod."
    exit 1
    ;;
esac

SCRIPT_NAME="$(basename "$0")"
LOG_FILE="aso-plg-migration-${ENV}-$(date +%Y%m%d_%H%M%S).log"
UPDATED_BY="system"

# =============================================================================
# LOGGING
# =============================================================================

log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line="[$timestamp] [$level] $message"
  echo "$line"
  echo "$line" >> "$LOG_FILE"
}

log_info()    { log "INFO " "$@"; }
log_warn()    { log "WARN " "$@"; }
log_error()   { log "ERROR" "$@"; }
log_action()  { log "ACTION" "$@"; }
log_skip()    { log "SKIP " "$@"; }
log_dry()     { log "DRY  " "(dry-run) $*"; }

# =============================================================================
# HELPERS
# =============================================================================

check_dependencies() {
  local missing=()
  for cmd in curl jq mysticat; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing required tools: ${missing[*]}"
    exit 1
  fi
}

get_token() {
  local token
  token="$(mysticat auth token --env "$ENV" 2>/dev/null)"
  if [ -z "$token" ]; then
    log_error "Failed to get auth token for env '$ENV'."
    log_error "Run: mysticat login --env $ENV --force"
    exit 1
  fi
  echo "$token"
}

is_in_exception_list() {
  local ims_org_id="$1"
  for exc in "${EXCEPTION_IMS_ORG_IDS[@]}"; do
    if [ "$exc" = "$ims_org_id" ]; then
      return 0
    fi
  done
  return 1
}

postgrest_patch() {
  local path="$1"
  local token="$2"
  local body="$3"
  curl --silent --fail \
    -X PATCH \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$body" \
    "${POSTGREST_URL}${path}"
}

postgrest_post() {
  local path="$1"
  local token="$2"
  local body="$3"
  curl --silent --fail \
    -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$body" \
    "${POSTGREST_URL}${path}"
}

# =============================================================================
# MIGRATION LOGIC
# =============================================================================

update_entitlement_to_pre_onboard() {
  local entitlement_id="$1"
  local token="$2"
  local org_id="$3"
  local org_name="$4"
  local ims_org_id="$5"

  log_action "Updating entitlement $entitlement_id → tier=PRE_ONBOARD | org='$org_name' ($org_id) ims=$ims_org_id"

  if [ "$DRY_RUN" = "true" ]; then
    log_dry "PATCH /entitlements?id=eq.$entitlement_id body={tier:PRE_ONBOARD, updated_by:$UPDATED_BY}"
    return 0
  fi

  local body
  body="$(jq -cn --arg tier "PRE_ONBOARD" --arg updated_by "$UPDATED_BY" \
    '{tier: $tier, updated_by: $updated_by}')"

  local result
  result="$(postgrest_patch "/entitlements?id=eq.${entitlement_id}" "$token" "$body")"
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    log_error "FAILED to update entitlement $entitlement_id for org '$org_name' ($org_id)"
    return 1
  fi

  local updated_id
  updated_id="$(echo "$result" | jq -r '.[0].id // empty')"
  if [ -z "$updated_id" ]; then
    log_error "PATCH returned unexpected response for entitlement $entitlement_id: $result"
    return 1
  fi

  log_info "SUCCESS updated entitlement $updated_id to PRE_ONBOARD | org='$org_name' ($org_id) ims=$ims_org_id"
  return 0
}

create_aso_pre_onboard_entitlement() {
  local org_id="$1"
  local token="$2"
  local org_name="$3"
  local ims_org_id="$4"

  log_action "Creating ASO/PRE_ONBOARD entitlement for org='$org_name' ($org_id) ims=$ims_org_id"

  if [ "$DRY_RUN" = "true" ]; then
    log_dry "POST /entitlements body={organization_id:$org_id, product_code:ASO, tier:PRE_ONBOARD, updated_by:$UPDATED_BY}"
    return 0
  fi

  local body
  body="$(jq -cn \
    --arg organization_id "$org_id" \
    --arg product_code "ASO" \
    --arg tier "PRE_ONBOARD" \
    --arg updated_by "$UPDATED_BY" \
    '{organization_id: $organization_id, product_code: $product_code, tier: $tier, updated_by: $updated_by}')"

  local result
  result="$(postgrest_post "/entitlements" "$token" "$body")"
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    log_error "FAILED to create entitlement for org '$org_name' ($org_id)"
    return 1
  fi

  local new_id
  new_id="$(echo "$result" | jq -r '.[0].id // empty')"
  if [ -z "$new_id" ]; then
    log_error "POST returned unexpected response for org '$org_name' ($org_id): $result"
    return 1
  fi

  log_info "SUCCESS created entitlement $new_id (ASO/PRE_ONBOARD) for org='$org_name' ($org_id) ims=$ims_org_id"
  return 0
}

# Return codes:
#   0 = skipped (exception list)
#   2 = created new ASO/PRE_ONBOARD entitlement
#   3 = updated FREE_TRIAL → PRE_ONBOARD
#   1 = error
process_organization() {
  local org="$1"
  local token="$2"

  local org_id org_name ims_org_id entitlement
  org_id="$(echo "$org" | jq -r '.organizationId')"
  org_name="$(echo "$org" | jq -r '.name // "(no name)"')"
  ims_org_id="$(echo "$org" | jq -r '.imsOrgId // ""')"
  entitlement="$(echo "$org" | jq -c '.entitlement')"

  log_info "--- Processing org='$org_name' ($org_id) ims=${ims_org_id:-(none)}"

  # Safety-net exception check (snapshot should already exclude these)
  if [ -n "$ims_org_id" ] && is_in_exception_list "$ims_org_id"; then
    log_skip "Org '$org_name' ($org_id) is in exception list (ims=$ims_org_id)"
    return 0
  fi

  if [ "$entitlement" = "null" ]; then
    log_info "No ASO entitlement → will create ASO/PRE_ONBOARD for org='$org_name' ($org_id)"
    create_aso_pre_onboard_entitlement "$org_id" "$token" "$org_name" "$ims_org_id"
    [ $? -eq 0 ] && return 2 || return 1
  else
    local ent_id ent_tier
    ent_id="$(echo "$entitlement" | jq -r '.id')"
    ent_tier="$(echo "$entitlement" | jq -r '.tier')"

    if [ "$ent_tier" = "FREE_TRIAL" ]; then
      update_entitlement_to_pre_onboard "$ent_id" "$token" "$org_id" "$org_name" "$ims_org_id"
      [ $? -eq 0 ] && return 3 || return 1
    else
      # Snapshot should not contain PAID/PRE_ONBOARD orgs, but handle defensively
      log_skip "Entitlement $ent_id has tier='$ent_tier' (not FREE_TRIAL) — skipping org='$org_name'"
      return 0
    fi
  fi
}

# =============================================================================
# MAIN
# =============================================================================

main() {
  # Validate INPUT_FILE
  if [ -z "$INPUT_FILE" ]; then
    echo "[ERROR] INPUT_FILE is required. Run fetch-orgs-snapshot.sh first, then:"
    echo "        INPUT_FILE=scripts/orgs-snapshot-${ENV}-<timestamp>.json ./${SCRIPT_NAME}"
    exit 1
  fi
  if [ ! -f "$INPUT_FILE" ]; then
    echo "[ERROR] Input file not found: $INPUT_FILE"
    exit 1
  fi

  local total_in_file
  total_in_file="$(jq 'length' "$INPUT_FILE")"

  log_info "=================================================="
  log_info "ASO → PRE_ONBOARD Entitlement Migration"
  log_info "ENV         : $ENV"
  log_info "POSTGREST   : $POSTGREST_URL"
  log_info "INPUT_FILE  : $INPUT_FILE ($total_in_file orgs)"
  log_info "DRY_RUN     : $DRY_RUN"
  log_info "LOG_FILE    : $LOG_FILE"
  log_info "EXCEPTIONS  : ${#EXCEPTION_IMS_ORG_IDS[@]} imsOrgId(s)"
  if [ "${#EXCEPTION_IMS_ORG_IDS[@]}" -gt 0 ]; then
    for exc in "${EXCEPTION_IMS_ORG_IDS[@]}"; do
      log_info "  - $exc"
    done
  fi
  log_info "=================================================="

  check_dependencies

  log_info "Fetching auth token for env='$ENV'..."
  TOKEN="$(get_token)"
  log_info "Auth token obtained."

  local total_processed=0
  local total_updated=0
  local total_created=0
  local total_skipped=0
  local total_errors=0

  log_info "Processing $total_in_file orgs from snapshot..."

  while IFS= read -r org; do
    ((total_processed++))

    # Re-fetch token periodically to avoid expiry on large datasets
    if [ $((total_processed % 50)) -eq 0 ]; then
      log_info "Refreshing auth token at org #$total_processed..."
      TOKEN="$(get_token)"
    fi

    process_organization "$org" "$TOKEN"
    local rc=$?

    local org_name
    org_name="$(echo "$org" | jq -r '.name // "(no name)"')"

    case $rc in
      0) ((total_skipped++)) ;;
      2) ((total_created++)) ;;
      3) ((total_updated++)) ;;
      *)
        ((total_errors++))
        log_error "Failed processing org='$org_name'"
        ;;
    esac
  done < <(jq -c '.[]' "$INPUT_FILE")

  log_info "=================================================="
  log_info "Migration complete."
  log_info "  Total orgs processed        : $total_processed"
  log_info "  Created (new ASO/PRE_ONBOARD)       : $total_created"
  log_info "  Updated (FREE_TRIAL→PRE_ONBOARD)    : $total_updated"
  log_info "  Skipped (exception/other)   : $total_skipped"
  log_info "  Errors                      : $total_errors"
  log_info "  DRY_RUN                     : $DRY_RUN"
  log_info "  Log file                    : $LOG_FILE"
  log_info "=================================================="

  if [ $total_errors -gt 0 ]; then
    log_warn "Completed with $total_errors error(s). Review $LOG_FILE for details."
    exit 1
  fi

  log_info "All done. No errors."
  exit 0
}

main "$@"
