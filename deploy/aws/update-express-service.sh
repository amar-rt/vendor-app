#!/bin/bash
# Redeploys a new image to an existing Express Mode service (used both for
# the one-time "fix SHOPIFY_APP_URL now that I know the real one" step, and
# by CI on every push — see ../../.github/workflows/deploy-ecs-express.yml).
#
# update-express-gateway-service takes the container spec as a whole
# replacement, not a partial patch, so this rebuilds the full
# --primary-container JSON exactly like create-express-service.sh, just
# targeting an existing --service-arn instead of creating a new one.
#
# Usage:
#   STACK_NAME=vendor-sync-express \
#   SERVICE_ARN=arn:aws:ecs:...:service/default/vendor-sync-express \
#   SHOPIFY_API_KEY=xxxx \
#   SHOPIFY_APP_URL=https://vendor-sync-express.ecs.us-east-1.on.aws \
#   IMAGE_TAG=latest \
#   ./deploy/aws/update-express-service.sh

set -euo pipefail

STACK_NAME="${STACK_NAME:-vendor-sync-express}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
: "${SERVICE_ARN:?Set SERVICE_ARN (from the create-express-service.sh output, or: aws ecs list-services --cluster default)}"
: "${SHOPIFY_API_KEY:?Set SHOPIFY_API_KEY}"
: "${SHOPIFY_APP_URL:?Set SHOPIFY_APP_URL}"
SCOPES="${SCOPES:-read_products,write_products,read_inventory,write_inventory,read_locations,write_files}"

out() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

ECR_URI=$(out EcrRepositoryUri)
DB_HOST=$(out DatabaseEndpoint)
DB_PORT=$(out DatabasePort)
DB_SECRET_ARN=$(out DatabaseSecretArn)
DB_NAME="${DB_NAME:-vendor_sync}"
SHOPIFY_API_SECRET_ARN="${SHOPIFY_API_SECRET_ARN:?Set SHOPIFY_API_SECRET_ARN}"

PRIMARY_CONTAINER=$(cat <<JSON
{
  "image": "${ECR_URI}:${IMAGE_TAG}",
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

echo "Updating Express Mode service..."
aws ecs update-express-gateway-service \
  --service-arn "$SERVICE_ARN" \
  --primary-container "$PRIMARY_CONTAINER" \
  --monitor-resources
