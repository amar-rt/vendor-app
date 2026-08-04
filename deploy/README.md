# Deploying to AWS

> **⚠️ AWS closed App Runner to new customers.** If you've never created an
> App Runner service before, you likely can't follow this file at all — AWS
> now points new customers to ECS Express Mode instead. See
> [README-ecs-express.md](README-ecs-express.md), which also happens to
> solve the "I don't have a domain" problem this file doesn't. This file is
> kept for reference / for anyone who does have existing App Runner access.

Three paths are available:
- **This file**: App Runner + Neon. Simplest *if* your account can still use App Runner.
- **[README-ecs-express.md](README-ecs-express.md)**: ECS Express Mode + RDS. The current recommendation for new setups — zero-domain HTTPS URL, AWS-native Postgres.
- **[README-ec2.md](README-ec2.md)**: EC2 + RDS Postgres. Database stays entirely inside AWS's network, but you take on TLS/ALB and deploy scripting yourself, and you need to already own a domain.

**Approach: AWS App Runner**, built from the Dockerfile at the repo root, images pushed to a private ECR repo by GitHub Actions on every push to `main`.

Why App Runner over ECS/Fargate or EC2: this app doesn't need a VPC (the database is Neon Postgres, reached over the public internet with TLS, not inside AWS's network) or a load balancer of its own — App Runner gives you a managed HTTPS endpoint, autoscaling, and rolling deploys out of the box, with none of the ALB/target-group/security-group setup ECS would need. It costs a little more per request than raw Fargate at real scale, but for a Shopify app installed on a handful of vendor stores, the ops savings are worth far more than the difference in compute cost. If this ever needs to live inside a VPC (e.g. talking to RDS privately) or needs finer-grained scaling control, ECS Fargate is the natural next step — the Docker image doesn't change, only the hosting layer would.

## One-time setup

### 1. Create the two secrets this app needs

```sh
aws secretsmanager create-secret \
  --name vendor-sync/database-url \
  --secret-string "postgresql://user:pass@your-neon-host/db?sslmode=require"

aws secretsmanager create-secret \
  --name vendor-sync/shopify-api-secret \
  --secret-string "<your Shopify app's Client Secret>"
```

Note the two ARNs printed — you'll pass them as parameters below.

### 2. Deploy the ECR repo + App Runner service

```sh
aws cloudformation deploy \
  --template-file deploy/aws/app-runner.yaml \
  --stack-name vendor-sync \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ShopifyApiKey="<client_id from shopify.app.toml>" \
    ShopifyAppUrl="https://placeholder.example.com" \
    DatabaseUrlSecretArn="<arn from step 1>" \
    ShopifyApiSecretArn="<arn from step 1>"
```

`ShopifyAppUrl` is a real chicken-and-egg problem: App Runner won't tell you
the service's URL until it exists, but the app needs that URL as an env
var. Deploy once with a placeholder, then:

```sh
aws cloudformation describe-stacks --stack-name vendor-sync \
  --query "Stacks[0].Outputs"
```

Take the `ServiceUrl` value, then re-run the same `deploy` command with the
real URL in `--parameter-overrides`. (CloudFormation only updates what
changed — this is a normal update, not a rebuild.)

### 3. Push the first image

The stack exists but there's no image in ECR yet, so the App Runner service
will be sitting in a failed/rollback state until you push one. Either push
manually once —

```sh
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

docker build -t vendor-sync .
docker tag vendor-sync:latest <account-id>.dkr.ecr.<region>.amazonaws.com/vendor-sync:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/vendor-sync:latest
```

— or just set up CI first (next section) and let it do this push for you.

### 4. Set up CI (GitHub Actions → ECR, via OIDC — no AWS keys in GitHub)

Deploy the one-time OIDC role (once per AWS account):

```sh
aws cloudformation deploy \
  --template-file deploy/aws/github-oidc-role.yaml \
  --stack-name vendor-sync-github-oidc \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg="<your-org>" \
    RepoName="vendor-app"
```

If your AWS account already has *any* GitHub OIDC provider registered
(from another project), add `CreateOidcProvider=false` — an account can
only have one.

Take the `DeployRoleArn` output and add it to the GitHub repo as a secret
named `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets and variables → Actions).
Also add a repo **variable** `AWS_REGION` if you're not using `us-east-1`.

From here, every push to `main` builds the Docker image and pushes it to
ECR ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)) —
App Runner is watching the `latest` tag and rolls out automatically.

### 5. Point the Shopify app config at the real URL

Update `application_url` and `auth.redirect_urls` in
[shopify.app.toml](../shopify.app.toml) to the real `ServiceUrl` (or your
custom domain, if you attach one to the App Runner service), then:

```sh
npm run deploy
```

to push the config to Partners.

## Ongoing deploys

Just `git push` to `main`. CI builds, pushes to ECR, App Runner rolls out —
`prisma migrate deploy` runs automatically on container start
([package.json](../package.json)'s `docker-start` script), so schema
migrations ship with the same deploy, no separate step.

## What's in this directory

| File | Purpose |
|---|---|
| [aws/app-runner.yaml](aws/app-runner.yaml) | ECR repo + App Runner service + IAM roles. The actual app infrastructure — one stack per environment. |
| [aws/github-oidc-role.yaml](aws/github-oidc-role.yaml) | Account-level, one-time: lets GitHub Actions push to ECR without stored AWS keys. |
| [../.github/workflows/deploy.yml](../.github/workflows/deploy.yml) | CI: build + push image on every push to `main`. |
| [../Dockerfile](../Dockerfile) | Multi-stage build — full toolchain to compile, prod-only deps to run. |
