# Enterprise layer loading and license expiry

## Retired scope

The upstream enterprise layer, license-expiry UI and edition API are retired.
There is no current enterprise-layer loading or license-grace-period acceptance
recipe. The former registration, expiry and hosted-readiness tests are removed;
no equivalent replacement is claimed.

Earlier results used disposable fixtures, stand-in layers, throwaway signing
keys and temporary homes. They did not qualify a real license, hosted tenant,
Cloud Admin, packaged build or deployment. Do not restore the retired layer to
satisfy historical recipes, or use real credentials or user data in fixtures.

Current product-account and gateway authorization are separate contracts, not
replacements for enterprise licenses or their former grace period.
