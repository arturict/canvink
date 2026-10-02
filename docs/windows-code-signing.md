# Windows code-signing readiness

## Status and activation boundary

Canvink is ready to sign Windows builds when a trusted external certificate is supplied, but the normal local build and release workflow remain unsigned. The repository does not contain a certificate, private key, password, or self-signed development certificate, and this readiness work is not evidence that a signed build has been produced.

The unsigned path uses `src-tauri/tauri.conf.json` and remains the default:

```powershell
pnpm tauri:build:windows
```

The signed path is explicit. Tauri merges `src-tauri/tauri.signing.conf.json`, whose supported `bundle.windows.signCommand` hook calls the fail-closed signing script for the application executable and Windows installers. The GitHub release workflow uses that overlay only when `sign_windows: true` is selected. Tauri documents both certificate-thumbprint signing and custom `signCommand` hooks for Windows bundles in its [Windows code-signing guide](https://v2.tauri.app/distribute/sign/windows/).

## External certificate requirement

Obtain an Authenticode Code Signing certificate from a publicly trusted certificate authority or managed signing provider. It must have all of these properties:

- It is currently valid and chains to a trusted root with successful online revocation checking.
- Its private key is available to the Windows account performing the signing.
- Enhanced Key Usage contains Code Signing OID `1.3.6.1.5.5.7.3.3`.
- Key Usage permits digital signatures when that extension is present.
- Its provider permits SignTool signing from the intended Windows runner or local machine.
- The certificate issuer provides an HTTPS RFC 3161 timestamp URL.

Microsoft documents the Code Signing EKU and private-key requirements in its [SignTool package-signing prerequisites](https://learn.microsoft.com/windows/win32/appxpkg/how-to-sign-a-package-using-signtool). SignTool's `/tr` and `/td SHA256` options request RFC 3161 timestamping, as described in the [SignTool reference](https://learn.microsoft.com/windows/win32/seccrypto/signtool). Use the timestamp URL specified by the certificate provider; do not substitute the placeholder domains used in tests.

Do not create or trust a self-signed certificate for a public release. A hardware-backed or managed key provider is preferable when the chosen certificate service supports unattended CI under an appropriately protected identity. The current workflow implements the protected PFX path; adding a cloud or hardware provider requires a separate reviewed adapter that preserves the same preflight and verification contract.

## Local Windows certificate-store path

Install the external certificate and private key into exactly one of these Personal stores:

- `Cert:\CurrentUser\My`
- `Cert:\LocalMachine\My`

Set only non-secret selection and policy values in the shell. Never paste a PFX payload or password into a command, repository file, or build log.

```powershell
$env:CANVINK_WINDOWS_SIGNED = '1'
$env:CANVINK_WINDOWS_SIGN_PROVIDER = 'windows-store'
$env:CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT = '<40-hex-thumbprint>'
$env:CANVINK_WINDOWS_TIMESTAMP_URL = 'https://<issuer-rfc3161-endpoint>'
pnpm release:preflight:signed
```

The preflight requires Windows PowerShell, Windows SDK SignTool, exactly one matching Personal-store certificate, an accessible private key, the Code Signing EKU, acceptable key usage, current validity, and a trusted online chain. It exits nonzero before packaging if any check fails.

After a successful preflight, build and verify with the signing overlay:

```powershell
pnpm tauri build --bundles nsis,msi --config src-tauri/tauri.signing.conf.json --ci -- --locked
pnpm release:verify:signed
```

`release:verify:signed` requires every discovered NSIS/MSI artifact and `src-tauri/target/release/Canvink.exe` to have `Get-AuthenticodeSignature` status `Valid`, the configured signer thumbprint, a timestamp certificate, and a successful SignTool policy verification. Microsoft's [`Get-AuthenticodeSignature` documentation](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature) describes the Windows signature status returned by that cmdlet.

## Protected GitHub Actions PFX path

Configure these values before requesting a signed run:

- Actions secret `WINDOWS_SIGNING_PFX_BASE64`: base64 of the externally issued PFX.
- Actions secret `WINDOWS_SIGNING_PFX_PASSWORD`: the PFX password.
- Actions variable `WINDOWS_TIMESTAMP_URL`: the certificate provider's HTTPS RFC 3161 endpoint.

Restrict secret administration and release workflow dispatch to trusted maintainers. Rotate or revoke the certificate through its issuer after suspected exposure; rotating a repository secret alone does not revoke a compromised certificate.

Dispatch `.github/workflows/release.yml` with the exact release tag, `publish: false`, and `sign_windows: true`. The Windows job imports the PFX as non-exportable into the ephemeral runner's Current User Personal store, deletes the temporary PFX, runs the preflight, signs through Tauri's hook, and verifies the built and installed executables plus both installer formats. It removes the imported certificates in an always-run cleanup step. Secret values are not passed as command-line arguments or printed by the signing script.

If any required secret or variable is absent, certificate validation fails, SignTool returns a warning or error, the timestamp request fails, a nested executable is unsigned, or Windows reports a signature status other than `Valid`, the job fails and no draft is created. With `sign_windows: false`, those secrets are not read, the signing overlay is not loaded, and the existing unsigned invariant remains enforced.

## Evidence boundary

The repository tests prove that signed mode is opt-in and blocked without its prerequisites. A release may be described as Authenticode-signed only after an explicit signed workflow run completes and the exact draft's `SIGNING-STATUS.txt`, checksums, attestations, installed-package smokes, and manual promotion checks have been verified. Until an external certificate is configured and that run succeeds, describe Canvink Windows packages as unsigned.
