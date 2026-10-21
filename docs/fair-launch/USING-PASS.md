# Using PASS and your Vault

Open the [app](https://www.ikol.top/alphaforge/) with your wallet on Robinhood Chain, chain ID 46630. Connect your wallet and select **Continue with wallet** to sign the ownership message. This message opens an account session without moving assets. Mint TSLA PASS or buy AMZN PASS before funding the corresponding Vault; buying PASS and depositing AF-USDC are separate payments.

The two fixed strategies record simulated stock holdings against authorized Alpaca IEX prices. One AF-USDC represents one dollar for this ledger. No brokerage order is placed. Real AF-USDC remains in the owner's on-chain Vault, and simulation cannot increase its withdrawable balance.

1. In **My Account**, choose **Use PASS** and **Deposit**. The first deposit creates your own Vault, requests the required token approvals, then funds it. Depositing 10 AF-USDC locks 10 PASS. After at least three canonical confirmations, the server records at most one simulated TSLA or AMZN entry using a current authorized quote. Additional deposits buy additional simulated units at their own entry prices.
2. **Stop** pauses new simulated entries and keeps existing holdings exposed to price changes. It also retires old automation consents. An existing on-chain executor grant requires wallet revocation and confirmation. Broadcast funding must finish reconciliation; stopping cannot cancel it.
3. **Withdraw** closes the real Vault, returns its actual tracked cash and releases all locked PASS. It archives the simulated position and preserves its realized result. Missing or stale stock prices cannot block cash closure. If no valid exit valuation is available, historical simulation awaits valuation instead of inventing a sale price.

Deposit requires an open regular US market session and a fresh authorized quote before requesting wallet funding. If a quote expires while funding confirms, the deposited money remains real cash and the simulated entry is pending. Stop cancels that unfilled entry. Restarting a stopped position requires a new Deposit action. Closed sessions, outages and stale observations are visibly identified; old prices are never relabeled as current execution prices.

The personal panel shows actual principal, cash and locked PASS separately from simulated units, reference value, unrealized and realized profit, return, recorded value curve, activity and price time. Its total reference value subtracts allocated principal from physical cash before adding simulated value, so principal is counted once. Contributions are not profit. Closed Vault results remain available separately from a new Vault. The stock benchmark chart does not represent a user's personal return.

## Runtime configuration

AF_MARKET_RPC_MODE=OFFICIAL selects https://rpc.testnet.chain.robinhood.com. The global chain event index refreshes every 30 seconds. Wallet funding, approval, closure and confirmation still require the actual chain. The official public endpoint is rate limited; it provides no guaranteed production quota or archival service. See [Robinhood connection documentation](https://docs.robinhood.com/chain/connecting/).

The administrator saves Alpaca credentials through the authenticated **Market-data setup** page. Credentials stay in the existing private server file, mode 0600, and are never returned by the API. AF_PAPER_DATA_AUTHORIZED=1 is the trusted deployment flag for public display authorization. Saving credentials alone cannot enable public data. The project owner has confirmed permission for the current user-facing use.

One shared source batch supplies TSLA and AMZN every 30 seconds. During an open session it performs one clock request, one calendar request and two quote requests; closed sessions need only clock and calendar. All viewers reuse these observations. Personal valuation reads the confirmed chain index and private ledger without issuing blockchain RPC requests. The source uses GET only and has no brokerage order capability. IEX is a single-exchange reference, not consolidated SIP/NBBO.

The separate private vault-paper.sqlite database has application ID 1095126352 and schema version 1. It stores canonical funding evidence, virtual fills and shared price marks. Existing financial and Vault-run schemas remain unchanged. Funding is identified by transaction and event kind across block reorganizations; a conflicting canonical anchor freezes derived value for review. Missing index evidence waits for synchronization. Publication recovery restores code only and never rolls ledgers back to an earlier snapshot.

Current limitations: simulated gains are not payable on chain; no profit settlement pool, real brokerage execution or stock worker is enabled. Previous real stock-token holdings cannot be silently converted to simulated holdings and require their existing settlement path. Deployment on chain 46630 does not confer real stock ownership or a mainnet cash settlement guarantee.
