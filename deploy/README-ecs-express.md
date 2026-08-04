# Deploying to AWS — ECS Express Mode + RDS

**This solves the "I don't have a domain" problem.** Unlike the EC2 path
([README-ec2.md](README-ec2.md)), you don't need to own a domain or set up
ACM/Route 53 — ECS Express Mode gives you a working HTTPS URL
(`https://<service-name>.ecs.<region>.on.aws`) with automatic TLS,
zero domain setup.

**Why this instead of App Runner** (the path in [README.md](README.md)):
AWS closed App Runner to new customers. If you've never used it before,
you likely can't create a new service — AWS's own migration guide points
new customers here instead. Express Mode gives the same "one call,
get infrastructure" experience App Runner did.

**The trade-off**: this is a brand-new AWS feature (2025). There's no
CloudFormation resource type for the Express Mode service itself yet, so
provisioning is split — RDS, ECR, and the IAM roles are in
[ecs-express-rds.yaml](aws/ecs-express-rds.yaml) as usual, but the actual
service is created by a plain CLI call
([create-express-service.sh](aws/create-express-service.sh)). I verified
the CLI's parameters and behavior against AWS's documentation, but
couldn't test an actual deploy against a live account — if a command
errors, the error message will tell us exactly what to fix.

## Prerequisites

Your account's **default VPC** — Express Mode uses it automatically, so
RDS needs to live there too:

```sh
aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].{VpcId:VpcId,Cidr:CidrBlock}"
aws ec2 describe-subnets --filters Name=vpc-id,Values=<VpcId> --query "Subnets[].SubnetId"
```

If your account has no default VPC (some older or heavily-customized
accounts don't), create one or adapt the template to use a VPC you do
have — same principle as the EC2 path, just without the ALB/ACM/domain
pieces.

The Shopify API secret, same as the other paths:

```sh
aws secretsmanager create-secret \
  --name vendor-sync/shopify-api-secret \
  --secret-string "<your Shopify app's Client Secret>"
```

## Deploy the supporting infrastructure

```sh
aws cloudformation deploy \
  --template-file deploy/aws/ecs-express-rds.yaml \
  --stack-name vendor-sync-express \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="<from prerequisites>" \
    VpcCidr="<from prerequisites>" \
    SubnetIds="<subnet-1>,<subnet-2>" \
    ShopifyApiSecretArn="<arn from prerequisites>"
```

## Push the first image

```sh
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

docker build -t vendor-sync-express .
docker tag vendor-sync-express:latest <account-id>.dkr.ecr.<region>.amazonaws.com/vendor-sync-express:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/vendor-sync-express:latest
```

## Create the Express Mode service

```sh
STACK_NAME=vendor-sync-express \
SERVICE_NAME=vendor-sync-express \
SHOPIFY_API_KEY="<client_id from shopify.app.toml>" \
SHOPIFY_APP_URL="https://placeholder.example.com" \
SHOPIFY_API_SECRET_ARN="<arn from prerequisites>" \
./deploy/aws/create-express-service.sh
```

Watch the output for the **Application URL**
(`https://vendor-sync-express.ecs.<region>.on.aws` or similar — the exact
format depends on whether AWS appends a suffix to your chosen service
name, which is why `SHOPIFY_APP_URL` starts as a placeholder here rather
than something I could predict for you). Once you have the real URL and
the service ARN from the same output, fix the URL:

```sh
STACK_NAME=vendor-sync-express \
SERVICE_ARN="<from the create output>" \
SHOPIFY_API_KEY="<client_id>" \
SHOPIFY_APP_URL="<the real URL from above>" \
SHOPIFY_API_SECRET_ARN="<arn from prerequisites>" \
IMAGE_TAG=latest \
./deploy/aws/update-express-service.sh
```

## Set up CI

Same OIDC role as the other paths, extended for ECS Express (skip if
already deployed for App Runner/EC2 — just make sure `ExpressServiceName`
matches):

```sh
aws cloudformation deploy \
  --template-file deploy/aws/github-oidc-role.yaml \
  --stack-name vendor-sync-github-oidc \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg="<your-org>" \
    RepoName="vendor-app" \
    ExpressServiceName="vendor-sync-express"
```

In the GitHub repo, add:
- Secret `AWS_DEPLOY_ROLE_ARN` — the `DeployRoleArn` output above (shared with the other paths).
- Secret `EXPRESS_SERVICE_ARN` — the service ARN from the create step.
- Secret `SHOPIFY_API_SECRET_ARN`.
- Variable `SHOPIFY_API_KEY`.
- Variable `SHOPIFY_APP_URL` — the real URL, once known.

[deploy-ecs-express.yml](../.github/workflows/deploy-ecs-express.yml)
deploys automatically on every push to `main` — typecheck + lint run first
in a separate `validate` job, and the build/push/deploy job only runs if
that passes, so a broken commit gets caught before it reaches the running
service. It's also runnable on demand (`workflow_dispatch`) from the
Actions tab. The other two workflows
([deploy.yml](../.github/workflows/deploy.yml) for App Runner,
[deploy-ec2.yml](../.github/workflows/deploy-ec2.yml) for EC2) are
untouched and stay manual-only, since this is the path you're actually
using.

## Point the Shopify app config at the real URL

```
application_url = "https://vendor-sync-express.ecs.<region>.on.aws"
```

in `shopify.app.toml` (and matching `redirect_urls`), then `npm run
deploy`.

## Operating it

- **Status / URL**: `aws ecs describe-express-gateway-service --service-arn <arn>`
- **Logs**: CloudWatch Logs — Express Mode wires this up automatically as part of the execution role's `AmazonECSTaskExecutionRolePolicy`; find the log group under `/ecs/` in the CloudWatch console.
- **Manual redeploy**: re-run `update-express-service.sh` with a new `IMAGE_TAG`.

## What's in this directory (ECS Express path)

| File | Purpose |
|---|---|
| [aws/ecs-express-rds.yaml](aws/ecs-express-rds.yaml) | RDS (in your default VPC), ECR repo, and the two IAM roles Express Mode needs. |
| [aws/create-express-service.sh](aws/create-express-service.sh) | One-time: stands up the actual Express Mode service (no CFN resource type exists for this yet). |
| [aws/update-express-service.sh](aws/update-express-service.sh) | Redeploys a new image to an existing service — used for the URL fix-up above, and by CI. |
| [aws/github-oidc-role.yaml](aws/github-oidc-role.yaml) | Shared with the other paths — also grants ECS Express deploy access. |
| [../.github/workflows/deploy-ecs-express.yml](../.github/workflows/deploy-ecs-express.yml) | CI: build + push, then redeploy via `update-express-service.sh`. |
| [../docker-entrypoint.sh](../docker-entrypoint.sh) | Assembles `DATABASE_URL` from RDS's separately-injected `DB_USERNAME`/`DB_PASSWORD` secrets at container start — no AWS mechanism interpolates multiple secrets into one connection string, so this has to happen here. |
