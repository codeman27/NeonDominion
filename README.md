# Neon Dominion

Neon Dominion is a turn-based hex strategy game built with TypeScript and Vite. It supports solo play against bots and asynchronous multiplayer over Nostr.

Maps use the same mobile-style rotation on all screen sizes, including previews, solo games, multiplayer setup/gameplay and Map Lab.

## Friends

For accounts created on this device, open **Manage Account > Account Settings** to reveal your masked NSEC below Public Identity, then select it or use **Copy NSEC**. Anyone with this private key can log in as you. The key is hidden again when you close Account Settings or leave the account screen. Restore access on another device using **Log In With NSEC**. Imported keys stay memory-only by default. Opt into **Remember on this device** to keep an imported login across refreshes: this stores the NSEC unencrypted in that site's browser storage, so use it only on a trusted device. **Disconnect** deletes that site's remembered NSEC. Browser-signer accounts must be backed up in their signer.

After logging in, open **Multiplayer > Friends** to search by a complete commander name (case-insensitive) or an `npub` public identity. Multiplayer automatically publishes your commander name and public identity to the default Nostr relays when you connect or save your name. Existing accounts become discoverable when they next open Multiplayer. Names are not unique: compare the full npub with your friend before sending a request. Name searches return up to 100 matches per relay; use an npub to disambiguate.

The recipient sees pending requests when they open Friends, where they can accept or decline. Accepted requests appear in both players' friend lists. You can cancel outgoing requests or remove friends. Friends are tied to the signing identity, not to the local commander-name label, and synchronize through the default relays across devices using the same account.

Profiles, requests, declines, removals and friendships are **public**, signed, app-specific Nostr events (kind `30078`). They do not modify an existing Nostr profile or contact list. Disconnecting or forgetting a local account does not delete published relay data. Only act after synchronization; delivery requires at least one relay acknowledgment, and partial failures are shown explicitly. Relays can retain, reject, prune or disagree about events, so recipients must use a shared working relay and may need to refresh. Publication failures leave the local name intact and offer a retry.

## Inviting friends to a game

Multiplayer games have stable, map-themed two-word names such as **Arctic Storm**, shown in invitations, My Games and the lobby. Names are derived from the game's random identity, so all players see the same name, including for existing games. Names are labels rather than unique identifiers; different games can share a name.

Open **Host Game**, choose a player limit, select friends from the list, and choose **Create Game & Invite Friends**. Select at least one friend and no more than the player limit minus your own seat (up to seven friends). Only accepted friends are available. The selected invitation list is fixed when the game is created; invitations use the shared default relays.

Recipients see **Game Invitations** on Multiplayer. **Accept Invitation & Join** signs their acceptance and automatically adds them to the lobby, even while the host is offline. The host can start once at least one friend has accepted. Non-invited identities cannot join just by obtaining the routing code. Invitation recipients and signed friendship proofs are public, and removing a friend later does not revoke an already-issued game invitation. No background notifications are sent; open Multiplayer or refresh invitations to check. Closed or already-started games cannot admit new players. After joining, use **My Games** to return.

Existing games without a friend invitation list retain their original code-sharing and host-approval flow. All players should use the current app for friend-only games.

### Recovering games on another site or device

Multiplayer automatically searches shared relays for games you hosted or joined with the current public identity; **Sync My Games** retries recovery. Signing into localhost and the hosted site with the same NSEC uses the same identity, but browser storage is separate. Recovery validates signed creation and game history before merging them into the current site's My Games, preserving any local pending action. You do not need another invitation or approval to recover an existing seat.

Recovery depends on relay retention and availability. It scans up to ten pages of account history and reports scan limits, incomplete history and per-game failures; custom-relay-only games must be opened from their original site. Discovery only contacts the app's shared default relays, never arbitrary addresses from remote events. Merely invited games remain in Game Invitations until you join.

**Keep the original site's data.** Private setup secrets, witness/hash-chain roots, signing bindings and unpublished turns do not move with your NSEC and are not uploaded by discovery. A recovered game can be listed without being safely playable at every phase from a new site; finish private setup or send pending turns from the original site. Do not play the same seat concurrently on multiple sites.

## Deploying

Pushing to `master` runs the GitHub Actions deployment workflow. The workflow runs the test suite, builds the site, syncs `dist/` to a private S3 bucket, and invalidates CloudFront.

Hosting is provisioned with [deploy/infra.yml](./deploy/infra.yml). It creates the private S3 bucket, CloudFront distribution, Route 53 records, and a GitHub OIDC role restricted to this repository's `master` branch. The default site domain is `neon-dominion.cody-roof.com`.

The workflow requires these repository actions secrets, populated from the CloudFormation stack outputs:

- `AWS_ROLE_ARN` from `DeployRoleArn`
- `SITE_BUCKET` from `BucketName`
- `DISTRIBUTION_ID` from `DistributionId`

The stack expects the existing `*.cody-roof.com` ACM certificate and Route 53 hosted zone. Deploy the stack in `us-east-1`; CloudFront uses the certificate in that region.

Run the app locally with `npm install` and `npm run dev`. Run tests with `npm test`; run the production typecheck and build with `npm run build`.
