# Neon Dominion

Neon Dominion is a turn-based hex strategy game built with TypeScript and Vite. It supports solo play against bots and asynchronous multiplayer over Nostr.

## Deploying

Pushing to `master` runs the GitHub Actions deployment workflow. The workflow runs the test suite, builds the site, syncs `dist/` to a private S3 bucket, and invalidates CloudFront.

Hosting is provisioned with [deploy/infra.yml](./deploy/infra.yml). It creates the private S3 bucket, CloudFront distribution, Route 53 records, and a GitHub OIDC role restricted to this repository's `master` branch. The default site domain is `neon-dominion.cody-roof.com`.

The workflow requires these repository actions secrets, populated from the CloudFormation stack outputs:

- `AWS_ROLE_ARN` from `DeployRoleArn`
- `SITE_BUCKET` from `BucketName`
- `DISTRIBUTION_ID` from `DistributionId`

The stack expects the existing `*.cody-roof.com` ACM certificate and Route 53 hosted zone. Deploy the stack in `us-east-1`; CloudFront uses the certificate in that region.

Run the app locally with `npm install` and `npm run dev`. Run tests with `npm test`; run the production typecheck and build with `npm run build`.
