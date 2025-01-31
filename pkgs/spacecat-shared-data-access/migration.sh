#!/bin/bash

# Define AWS CLI command with local DynamoDB endpoint
AWS_CMD="aws dynamodb --endpoint-url http://localhost:8000"
REGION="us-west-2"

# Define table names
SITE_TABLE="spacecat-services-sites"
ORGANIZATION_TABLE="spacecat-services-organizations"

# Fetch all sites
SITES=$($AWS_CMD scan --table-name $SITE_TABLE)
ORGANIZATIONS=$($AWS_CMD scan --table-name $ORGANIZATION_TABLE)

# Migrate each site
echo "$SITES" | jq -c '.Items[]' | while read -r site; do
    SITE_ID=$(echo $site | jq -r '.id.S')
    BASE_URL=$(echo $site | jq -r '.baseURL.S')
    DELIVERY_TYPE=$(echo $site | jq -r '.deliveryType.S')
    GITHUB_URL=$(echo $site | jq -r '.gitHubURL.S')
    ORG_ID=$(echo $site | jq -r '.organizationId.S')
    IS_LIVE=$(echo $site | jq -r '.isLive.BOOL // false')
    IS_LIVE_TOGGLED_AT=$(echo $site | jq -r '.isLiveToggledAt.S // empty')
    GSI1PK=$(echo $site | jq -r '.GSI1PK.S')
    CREATED_AT=$(echo $site | jq -r '.createdAt.S')
    UPDATED_AT=$(echo $site | jq -r '.updatedAt.S')
    SLACK=$(echo $site | jq -r '.config.M.slack // {"M": {}}')
    IMPORTS=$(echo $site | jq -r '.config.M.imports // {"L": []}')
    HLX_CONFIG=$(echo $site | jq -r '.hlxConfig // {"M": {}}')

    # Check for 404 and broken-backlinks mentions
    ALERTS=$(echo $site | jq -c '.config.M.alerts.L')
    MENTIONS_404_SLACK='{"L":[]}'
    MENTIONS_BROKEN_BACKLINKS_SLACK='{"L":[]}'
    for alert in $(echo "$ALERTS" | jq -c '.[]'); do
        ALERT_TYPE=$(echo $alert | jq -r '.M.type.S // empty')
        if [ "$ALERT_TYPE" == "404" ]; then
            MENTIONS_404_SLACK=$(echo $alert | jq -r '.M.mentions.L[0].M.slack // {"L":[]}')
        elif [ "$ALERT_TYPE" == "broken-backlinks" ]; then
            MENTIONS_BROKEN_BACKLINKS_SLACK=$(echo $alert | jq -r '.M.mentions.L[0].M.slack // {"L":[]}')
        fi
    done

    # Get excluded URLs
    EXCLUDED_URLS=$(echo $site | jq -c '.auditConfig.M.auditTypeConfigs.M["broken-backlinks"].M.excludedURLs // {"L" :[]} ')
    MANUAL_OVERWRITES=$(echo $site | jq -c '.auditConfig.M.auditTypeConfigs.M["broken-backlinks"].M.manualOverwrites // {"L" :[]} ')
    FIXED_URLS=$(echo $site | jq -c '.auditConfig.M.auditTypeConfigs.M["broken-backlinks"].M.fixedURLs // {"L" :[]} ')
    MIGRATED_SITE=$(cat <<EOF
{
    "id": {"S": "$SITE_ID"},
    "baseURL": {"S": "$BASE_URL"},
    "deliveryType": {"S": "$DELIVERY_TYPE"},
    "gitHubURL": {"S": "$GITHUB_URL"},
    "organizationId": {"S": "$ORG_ID"},
    "isLive": {"BOOL": $IS_LIVE},
    "isLiveToggledAt": {"S": "$IS_LIVE_TOGGLED_AT"},
    "GSI1PK": {"S": "$GSI1PK"},
    "createdAt": {"S": "$CREATED_AT"},
    "updatedAt": {"S": "$UPDATED_AT"},
    "hlxConfig": $HLX_CONFIG,
    "config": {
        "M": {
            "slack": $SLACK,
            "imports": $IMPORTS,
            "handlers": {
                "M": {
                    "404": {"M": {"mentions": {"M": {"slack": $MENTIONS_404_SLACK}}}},
                    "broken-backlinks": {"M": {"mentions": {"M": {"slack": $MENTIONS_BROKEN_BACKLINKS_SLACK}}, "excludedURLs": $EXCLUDED_URLS, "manualOverwrites": $MANUAL_OVERWRITES, "fixedURLs": $FIXED_URLS}}
                }
              }
          }
    }
}
EOF
)

    # Insert migrated site data into the site table
    $AWS_CMD put-item --table-name $SITE_TABLE --item "$MIGRATED_SITE"
done

# Migrate each organization
echo "$ORGANIZATIONS" | jq -c '.Items[]' | while read -r org; do
    ORG_ID=$(echo $org | jq -r '.id.S')
    IMS_ORG_ID=$(echo $org | jq -r '.imsOrgId.S')
    NAME=$(echo $org | jq -r '.name.S')
    GSI1PK=$(echo $org | jq -r '.GSI1PK.S')
    CREATED_AT=$(echo $org | jq -r '.createdAt.S')
    UPDATED_AT=$(echo $org | jq -r '.updatedAt.S')
    FULLFILLABLE_ITEMS=$(echo $org | jq -r '.fulfillableItems // {"M": {}}')
    SLACK=$(echo $org | jq -r '.config.M.slack // {"M": {}}')
    IMPORTS=$(echo $org | jq -r '.config.M.imports // {"L": []}')

    # Check for 404 and broken-backlinks mentions
    ALERTS=$(echo $org | jq -c '.config.M.alerts.L')
    MENTIONS_404_SLACK='{"L":[]}'
    MENTIONS_BROKEN_BACKLINKS_SLACK='{"L":[]}'
    for alert in $(echo "$ALERTS" | jq -c '.[]'); do
        ALERT_TYPE=$(echo $alert | jq -r '.M.type.S // empty')
        if [ "$ALERT_TYPE" == "404" ]; then
            MENTIONS_404_SLACK=$(echo $alert | jq -r '.M.mentions.L[0].M.slack // {"L":[]}')
        elif [ "$ALERT_TYPE" == "broken-backlinks" ]; then
            MENTIONS_BROKEN_BACKLINKS_SLACK=$(echo $alert | jq -r '.M.mentions.L[0].M.slack // {"L":[]}')
        fi
    done



    MIGRATED_ORG=$(cat <<EOF
{
    "id": {"S": "$ORG_ID"},
    "imsOrgId": {"S": "$IMS_ORG_ID"},
    "name": {"S": "$NAME"},
    "GSI1PK": {"S": "$GSI1PK"},
    "createdAt": {"S": "$CREATED_AT"},
    "updatedAt": {"S": "$UPDATED_AT"},
    "fulfillableItems": $FULLFILLABLE_ITEMS,
    "config": {
        "M": {
          "slack": $SLACK,
          "imports": $IMPORTS,
          "handlers": {
              "M": {
                  "404": {"M": {"mentions": {"M": {"slack": $MENTIONS_404_SLACK}}}},
                  "broken-backlinks": {"M": {"mentions": {"M": {"slack": $MENTIONS_BROKEN_BACKLINKS_SLACK}}}}
              }
        }
    }
}
}
EOF
)

    # Insert migrated organization data into the organization table
    $AWS_CMD put-item --table-name $ORGANIZATION_TABLE --item "$MIGRATED_ORG"
done

echo "Migration completed successfully."
