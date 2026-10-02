# Canvink vendor patch

This directory vendors only `numbat-exchange-rates` 0.6.0 from the Numbat
repository. Canvink keeps Numbat itself pinned to the unmodified 1.23.0 release.

## Provenance

- Upstream repository: <https://github.com/sharkdp/numbat>
- Upstream path: `numbat-exchange-rates`
- Upstream version: `0.6.0`
- Upstream commit: `bbb1fb6053b6c7cea9af457ca133dfcaecd3f246`
- Published crate checksum: `2045c6d74fcd0b14f25d58321e1f7048feeddc89dbfd5441fda569a6ee9e08ca`
- Original `src/lib.rs` SHA-256: `b8044e2c774d2c6d876d221cf1402cae7cef3f60d875725d9be175dfc6a2a901`
- Original `Cargo.toml.orig` SHA-256: `60ee6387d022a516d3ef0c4453bac58377c7154ac5fc123c6e8ef88b259e2bdb`
- Upstream license: `MIT OR Apache-2.0`, unchanged

The upstream crate package does not bundle its repository-level license files,
so the matching license texts from the pinned upstream commit are included here.

## Local change

The only production dependency change is:

```toml
quick-xml = ">=0.41,<0.42"
```

Upstream 0.6.0 requires quick-xml 0.37.5, which is affected by
RUSTSEC-2026-0194 and RUSTSEC-2026-0195. The only parser API adjustment replaces
the two deprecated `unescape_value()` calls with quick-xml 0.41's
`decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())`;
control flow and public API remain unchanged. Integration tests cover representative ECB XML, the
large-attribute duplicate-detection path, and invalid rates.

Canvink builds Numbat with default features disabled and does not enable this
crate's `fetch-exchangerates` feature. Canvink currency conversion continues to
use only its separately validated local snapshot DTO; this patch does not add a
network or live-rate path.
