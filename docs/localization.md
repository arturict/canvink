# Localization

The `/app` notebook UI is German-first and can be switched to English without an account or network request.

- Catalogs live in `src/i18n/catalog.ts`. German is the source catalog; TypeScript requires the English catalog to contain every key.
- `useI18n()` exposes typed `t()` and locale-aware `plural()` helpers. Interpolation uses named placeholders such as `{count}`.
- The preference is stored only in local storage under `canvink:language:v1`. Missing, blocked, or invalid storage safely falls back to German.
- `I18nProvider` updates the document `lang` attribute. `LanguageSwitcher` supplies the accessible German/English selector.
- Protocol and storage errors remain stable internally. Visible UI boundaries translate known status messages and provide localized fallbacks without changing protocol payloads.

Run `pnpm exec vitest run src/i18n/i18n.test.ts` for catalog/preference checks and `pnpm exec playwright test tests/e2e/i18n-v2.spec.ts` for German-default plus English-switch/reload coverage.
