# Elevated driver installation

The installer never runs the bundled driver after a verification failure, and
never modifies the machine's TrustedPublisher store. Missing state, malformed
output, exceptions, signature timeouts, unknown status, unapproved signers and
hash mismatches all block execution. Signature reads have a 15-second deadline;
the installer process has a five-minute deadline.

`installer/driver-policy.json` intentionally contains no approved package yet.
Automatic driver installation is blocked until a maintainer obtains the official
package, verifies its provenance, and reviews its signer thumbprints and every
file's SHA-256 and size. Do not populate the policy by blindly trusting local
files. The policy has `version: 1`, `allowedSignerThumbprints`, and `files` entries
with `path` (a basename), `sha256`, and `size`. Packages must contain only those
reviewed files; setup, INF and the INF's catalog must be included. Both setup and
catalog require valid OS signature verification and a pinned signer.

FreqX installation itself can finish when the driver is blocked. Users can
install a verified official driver separately. The security regression tests
use inert fixtures and injected launch functions; they never install a driver.
