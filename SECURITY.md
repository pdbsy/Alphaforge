# Security Policy

## Scope

Only the current `master` branch is supported. This repository is a Robinhood Chain Testnet competition prototype. It does not support mainnet, real-value assets, unattended trading, or custody of user private keys.

## Intellectual property and permitted use

AlphaForge has not declared a repository-wide open-source license. Public access to this
repository does not, by itself, grant an additional license to its original source code,
documentation, diagrams, designs, or research materials. Except where an explicit license,
applicable law, or GitHub's Terms of Service permits otherwise, copying, redistribution,
derivative works, or commercial reuse requires permission from the applicable rights holder.
Rights not expressly granted are reserved.

File-level and component licenses, third-party notices, and valid permissions already
granted continue to apply. This policy does not replace or revoke them. In particular,
preserve the OpenZeppelin license and LEAN EMA attribution referenced in the README.
It grants no additional trademark or patent rights and does not claim exclusive ownership
of abstract ideas or independently developed work.

This repository is public: GitHub users can view and fork it under GitHub's Terms of
Service. This policy cannot prevent copying or recall existing forks, downloads, or clones.
Materials that must remain confidential belong in private, access-controlled storage.

## Confidential strategy and design material

- Keep unpublished strategy logic, research data, execution parameters, product plans,
  architecture details, and business-sensitive designs private until their owner approves
  public release. Limit access to people and applications that need it.
- Review commits, pull requests, issues, logs, screenshots, build artifacts, and generated
  documentation before publication. Share only what the approved public release needs;
  do not publish internal strategy implementations or private design discussions as evidence.
- Do not upload non-public code, strategy details, or design material to external services,
  public demos, or AI tools without the owner's authorization for that disclosure.
- If non-public material is exposed, stop further publication, notify the maintainer
  privately, and restrict further access. Revoke exposed credentials promptly; deleting
  a file or making a repository private does not recall copies already obtained.

## Private reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in the repository Security tab:

<https://github.com/pdbsy/Alphaforge/security/advisories/new>

Include the affected commit, preconditions, minimal reproduction, expected impact, and whether any secret may have been exposed. Do not include live credentials, seed phrases, private keys, or real-user data. We will acknowledge Critical reports within one day and High reports within three days. These are triage targets, not a bounty or payment promise.

## Safe handling

- Use local simulation or Robinhood Chain Testnet only.
- Use disposable accounts with no mainnet assets or reused keys.
- Stop after proving impact; do not persist access, degrade services, or access third-party data.
- Coordinate disclosure through the private advisory until a fix and release note are ready.

## Public artifact minimization

This public repository must not contain a combinable developer-workstation or remote-access
profile. Do not commit concrete local account or device identifiers, private-network coordinates,
home/project paths, key inventories or fingerprints, listener reachability, storage posture, or
exact host-package versions. Keep detailed host audits in a private access-controlled system and
commit only a non-identifying project outcome. `npm run privacy:check` enforces a bounded
current-tree baseline; reviewers must still apply judgment because no pattern scanner can recall
old clones or prove that prose is harmless.

## Current limitation

The repository is presently owned by a single personal GitHub account. An active no-bypass ruleset, CODEOWNERS and in-repository Actions improve change control, review routing and detection, but a single-owner setup, even with one required approval and CODEOWNER/last-push requirements, does not provide independent identity assurance or an immutable external governance check. `SUPPLY-001` and `GOV-001` remain incomplete until that external trust boundary is established and verified.
