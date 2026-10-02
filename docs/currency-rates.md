# Offline currency reference rates

Canvink ships a small, immutable currency snapshot for offline calculations.
It does not fetch exchange rates at runtime and does not parse XML at runtime.

## Current snapshot

- Official source: <https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml>
- Read from the ECB source on: 2026-08-03
- Reference-rate date (`asOf`): 2026-08-03
- Base: EUR
- Included currencies: EUR, USD, JPY, GBP, CHF, CAD, AUD
- Bundled file: `src-tauri/resources/math-currency-rates-v1.json`
- SHA-256: `cb9b1072cec06dcbb137776ed3fe25bcdee3e4bb1135177761f5167ab8fed42f`

The application derives freshness at conversion time from the UTC calendar
date. A snapshot is `current` from its `asOf` day through calendar day 7 and
`stale` before `asOf` or from day 8 onward. The JSON cannot declare its own
status.

## Update procedure

1. Download the ECB daily XML directly from the official HTTPS URL above.
2. Record the XML's reference-rate date and manually transfer only the seven
   allowlisted currencies. Keep EUR as the base and do not interpolate values.
3. Review the diff for the exact source label, date, currency set, positive
   finite rates, and absence of additional fields.
4. Recompute the JSON file's SHA-256 and update both this document and the
   compile-time hash assertion in `src-tauri/src/math_units.rs`.
5. Run the focused currency tests, full Rust tests, `cargo audit`, `cargo deny`,
   the notice check, and a packaged desktop build before release.

ECB reference rates are informational reference values, not executable trading
quotes. Banks, card networks, brokers, and payment providers can use different
rates and add spreads or fees. Canvink must therefore not present these results
as guaranteed purchase, sale, settlement, accounting, or tax rates.
