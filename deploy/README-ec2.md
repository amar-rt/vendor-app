# Deploying to AWS — EC2 + RDS alternative

> If you don't already own a domain, this path has a hard prerequisite you
> may not want to deal with (step 1 below). [README-ecs-express.md](README-ecs-express.md)
> gets you a working HTTPS URL with no domain needed — worth reading first.

This is the alternative to [README.md](README.md)'s App Runner path: a
single EC2 instance running the Docker image, behind an Application Load
Balancer that terminates TLS, talking to an RDS Postgres instance in a
private-facing security group. It deploys into its own VPC and its own ECR
repo ([deploy/aws/ec2-rds.yaml](aws/ec2-rds.yaml)), so it can coexist with
the App Runner stack without conflicting.

Trade-off versus App Runner, worth being clear-eyed about before you pick
this: App Runner gives you HTTPS, autoscaling, and rolling deploys for
free. Here, you're taking on all of that yourself — this template sets up
an ALB + ACM certificate for TLS (there's no way around needing *some*
form of HTTPS termination; Shopify requires valid HTTPS and won't accept a
bare EC2 IP or self-signed cert), and deploys go through a hand-rolled
script over SSM rather than a managed rollout. What you get in exchange:
the database never leaves AWS's private network, and if you're already
comfortable with EC2/VPC networking there's less unfamiliar surface than
learning App Runner.

## Prerequisites

- **A domain you control, on Route 53.** ACM can't issue a trusted
  certificate for a bare ALB DNS name, and the template auto-validates the
  certificate and creates the DNS record via a Route 53 hosted zone. If
  your DNS is elsewhere, you can still use this template — just remove the
  `DnsRecord` resource and the `HostedZoneId`-based validation from
  `ec2-rds.yaml`, and validate/point DNS manually.
- The Shopify API secret already in Secrets Manager (same as the App
  Runner path):
  ```sh
  aws secretsmanager create-secret \
    --name vendor-sync/shopify-api-secret \
    --secret-string "<your Shopify app's Client Secret>"
  ```
  (Skip this if you already created it for the App Runner path — reuse the
  same ARN.)

## Deploy the stack

```sh
aws cloudformation deploy \
  --template-file deploy/aws/ec2-rds.yaml \
  --stack-name vendor-sync-ec2 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DomainName="app.example.com" \
    HostedZoneId="Z0123456789ABCDEFGHIJ" \
    ShopifyApiKey="<client_id from shopify.app.toml>" \
    ShopifyApiSecretArn="<arn from prerequisites>"
```

This takes 10–15 minutes — RDS provisioning and ACM DNS validation are the
slow parts. Unlike the App Runner path, there's no `SHOPIFY_APP_URL`
chicken-and-egg problem here: since `DomainName` is a real domain you
already own and pass in up front, the instance's first boot script
(embedded in the CloudFormation template's `UserData`) uses it directly —
no placeholder-then-redeploy step needed.

The database's master password is managed entirely by AWS (RDS's
`ManageMasterUserPassword`, auto-stored in Secrets Manager, rotatable) —
you never see or set it. The EC2 instance's boot script fetches it at
container-start time and assembles the full connection string.

## Set up CI

Same OIDC role as the App Runner path, extended with SSM deploy
permissions — deploy once per account (skip if you already did this for
App Runner, just make sure `Ec2ServiceName` matches):

```sh
aws cloudformation deploy \
  --template-file deploy/aws/github-oidc-role.yaml \
  --stack-name vendor-sync-github-oidc \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg="<your-org>" \
    RepoName="vendor-app" \
    Ec2ServiceName="vendor-sync-ec2"
```

Add the `DeployRoleArn` output as the `AWS_DEPLOY_ROLE_ARN` GitHub secret
(same secret name as the App Runner path — one role covers both).

[.github/workflows/deploy-ec2.yml](../.github/workflows/deploy-ec2.yml) is
**manual-trigger only** (`workflow_dispatch`) by default, deliberately —
if both this and `deploy.yml` ran on every push, you'd be deploying to
both targets on every merge. Run it from the Actions tab, or flip its
`on:` to `push: { branches: [main] }` once you've picked this as your real
deploy target.

## Point the Shopify app config at the real URL

```
application_url = "https://app.example.com"
```

in `shopify.app.toml` (and matching `redirect_urls`), then `npm run
deploy` to push the config to Partners.

## Operating it

- **Shell access, no SSH key needed**: `aws ssm start-session --target <instance-id>` (the instance role already has `AmazonSSMManagedInstanceCore`).
- **Logs**: `docker logs app` on the instance (via the SSM session above).
- **Manual redeploy** (e.g. to re-pull `latest` without a new commit): `aws ssm send-command --document-name AWS-RunShellScript --targets "Key=tag:App,Values=vendor-sync-ec2" --parameters 'commands=["/opt/vendor-sync/deploy.sh"]'`.
- **Scaling / HA**: this template is deliberately a single instance, matching "EC2 deployment" as asked. If you need more than one instance, the natural upgrade is an Auto Scaling Group behind the same ALB — the Docker image and deploy script don't need to change, only the instance-management layer.

## What's in this directory (EC2 path)

| File | Purpose |
|---|---|
| [aws/ec2-rds.yaml](aws/ec2-rds.yaml) | VPC, RDS (private), EC2, ALB, ACM cert, Route 53 record, IAM. |
| [aws/github-oidc-role.yaml](aws/github-oidc-role.yaml) | Shared with the App Runner path — also grants SSM deploy access, scoped by instance tag. |
| [../.github/workflows/deploy-ec2.yml](../.github/workflows/deploy-ec2.yml) | CI: build + push to this stack's ECR repo, then trigger the instance's deploy script over SSM. |
