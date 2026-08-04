#!/bin/bash
# One-time (or re-run-to-recreate) helper: stands up the actual ECS Express
# Mode service, reading the rest of its inputs from the ecs-express-rds.yaml
# stack's outputs. There's no CloudFormation resource for the Express Mode
# service itself yet (very new AWS feature), so this is a CLI call rather
# than part of the template.
#
# Usage:
#   STACK_NAME=vendor-sync-express \
#   SERVICE_NAME=vendor-sync-express \
#   SHOPIFY_API_KEY=xxxx \
#   SCOPES="read_products,write_products,read_inventory,write_inventory,read_locations,write_files" \
#   SHOPIFY_APP_URL=https://placeholder.example.com \
#   ./deploy/aws/create-express-service.sh
#
# After the first run, note the printed Application URL, then re-run with
# SHOPIFY_APP_URL set to that real value (this re-runs create — if the
# service already exists, use update-express-service.sh instead).

set -euo pipefail

STACK_NAME="${STACK_NAME:-vendor-sync-express}"
SERVICE_NAME="${SERVICE_NAME:-vendor-sync-express}"
: "${SHOPIFY_API_KEY:?Set SHOPIFY_API_KEY (Client ID from shopify.app.toml)}"
: "${SHOPIFY_APP_URL:?Set SHOPIFY_APP_URL (placeholder is fine for the first run)}"
SCOPES="${SCOPES:-read_products,write_products,read_inventory,write_inventory,read_locations,write_files}"

out() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

ECR_URI=$(out EcrRepositoryUri)
EXECUTION_ROLE_ARN=$(out ExecutionRoleArn)
INFRASTRUCTURE_ROLE_ARN=$(out InfrastructureRoleArn)
DB_HOST=$(out DatabaseEndpoint)
DB_PORT=$(out DatabasePort)
DB_SECRET_ARN=$(out DatabaseSecretArn)
DB_NAME="${DB_NAME:-vendor_sync}"
SHOPIFY_API_SECRET_ARN="${SHOPIFY_API_SECRET_ARN:?Set SHOPIFY_API_SECRET_ARN (the secret you created with the Shopify Client Secret)}"

PRIMARY_CONTAINER=$(cat <<JSON
{
  "image": "${ECR_URI}:latest",
  "containerPort": 3000,
  "environment": [
    { "name": "NODE_ENV", "value": "production" },
    { "name": "DB_HOST", "value": "${DB_HOST}" },
    { "name": "DB_PORT", "value": "${DB_PORT}" },
    { "name": "DB_NAME", "value": "${DB_NAME}" },
    { "name": "SHOPIFY_API_KEY", "value": "${SHOPIFY_API_KEY}" },
    { "name": "SCOPES", "value": "${SCOPES}" },
    { "name": "SHOPIFY_APP_URL", "value": "${SHOPIFY_APP_URL}" }
  ],
  "secrets": [
    { "name": "DB_USERNAME", "valueFrom": "${DB_SECRET_ARN}:username::" },
    { "name": "DB_PASSWORD", "valueFrom": "${DB_SECRET_ARN}:password::" },
    { "name": "SHOPIFY_API_SECRET", "valueFrom": "${SHOPIFY_API_SECRET_ARN}" }
  ]
}
JSON
)

echo "Creating Express Mode service '${SERVICE_NAME}'..."
aws ecs create-express-gateway-service \
  --service-name "$SERVICE_NAME" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --infrastructure-role-arn "$INFRASTRUCTURE_ROLE_ARN" \
  --primary-container "$PRIMARY_CONTAINER" \
  --health-check-path "/" \
  --monitor-resources
