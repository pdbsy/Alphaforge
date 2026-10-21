# Online community and creator publications

The composed launch-market service owns community posts, replies, likes, bookmarks and wallet-private notes, drafts, profile and preferences. They persist in an independent private directory (`AF_COMMUNITY_DATA_DIR`, default `<AF_MARKET_DATA_DIR>-community`) with their own network identity, server lock and bounded quota. Two devices signed into the same wallet share these records without invalidating each other's session. Each device has its own CSRF token; current-device and all-device logout revoke the selected scope. Writes use the same selected wallet/Google identity and email-verification policy as market operations, exact origin, bounded input and persistent rate limits. Author ownership, optimistic revisions and private account filtering apply on the server.

Creator Studio accepts a validated JSON document or editor input with name, TSLA/AMZN symbol, summary, method, risks and a bounded BUY_AND_HOLD, DCA or EMA_CROSS policy. Publication records an immutable content version and digest. Editing a private draft preserves the prior public version. Publish/unpublish visibility has an independent revision, so a stale second device cannot override a newer decision. Public library reads never expose draft edits or private notebook content. Local notebook import requires an explicit user action and runs as one atomic operation. Failure preserves unsent form content.

A research publication does not create a PASS, deployment, Vault or execution permission. The current two-route factory cannot register arbitrary creator strategy IDs; such registration requires new verified contracts. Actual stock trading and automation prerequisites are documented in [stock-automation.md](stock-automation.md). The product displays readiness and enables owner consent only after the configured execution service and current chain state qualify.

Scoped verification commands use pinned Node 24.21.0 and independent dependencies:

```sh
node --test --test-isolation=none test/launch-community.test.ts test/creator-strategy.test.ts test/community-ui-client.test.ts test/launch-stock-consent-registry.test.ts test/launch-stock-automation-http.test.ts test/launch-stock-automation-ui.test.ts
node --test --test-isolation=none test/launch-product-features-http.test.ts
npm run typecheck
npm run build:web -- --base=/alphaforge/
node --test --test-isolation=none test/community-product.browser.test.ts
```

The HTTP and browser workflows use ephemeral databases and fixture wallets; they do not post records to the public community or sign/broadcast live financial transactions. Stock-worker checks use the separately bounded `test/launch-stock-worker.test.ts` and `test/launch-stock-reference.test.ts`. Production release uses a pinned stopped backup, qualifies financial-table preservation during the wallet-session schema migration, and keeps a schema-compatible code-only fallback. Database restore is never part of publication or rollback.
