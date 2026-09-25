# TrestleJS Regional Settings Specification

**Status:** The core model has shipped (#121). The user preferences and customer and admin surfaces below are not built yet.

**Parent specification:** [Administration and Access Control](ADMIN_SPEC.md)

**Principle:** Locale, time and money correctness is a foundation capability. Translation is an optional product capability.

## 1. What has shipped

- `organization_regional_settings` with forced RLS (migration 0027).
- Canonical identifiers and their validation:
  - BCP 47 for locale and language;
  - IANA for time zones;
  - ISO 4217 for currency.
- Resolution for each setting in the order operation, user, organization, application, with the source recorded (`packages/domain/src/regional/resolve.ts`). The user level exists in the resolver, but user preferences aren't stored yet.
- `GET` and `PUT /api/tenant/regional`, which return `{ effective, overrides, options }`, and the `organization.regional_settings.changed` audit event.
- Permissions: tenants read with `organization.read` and change settings with `organization.settings.manage`. The platform admin reads through its database role and never writes.
- A read-only regional view in the platform admin's organization detail page and in support sessions.

Application-wide defaults live in source (`packages/domain/src/regional`). The deployed admin never changes them.

## 2. Remaining work

Build these in order. Each item uses the shipped names above.

1. **The customer Regional page** (`apps/app` → Settings → Organization → Regional), with locale, time zone, and default currency where supported. For each setting it shows the effective value and where that value comes from.
2. **The user Language & Region page** (`apps/app` → Account → Language & Region).
   - This needs stored user preferences for language, locale and time zone.
   - Each setting offers "Use organization default".
   - The page tells the user's own preference apart from the organization default and the application default, without asking them to understand the resolution order.
   - Currency is not a user preference unless the application explicitly supports choosing a display currency.
3. **A formatting preview** on the organization page. It shows the date and time, date, number, currency and percentage, and updates before saving, so a code like `en-US` isn't opaque.
4. **Warnings before a change is saved:**
   - **Time zone:** "Future schedules that follow organization local time may occur at a different instant after this change. Historical timestamps are not changed." When Trestle can count the recurring schedules that follow organization time, show the count and a review action. Schedules with an explicit time zone are never rewritten.
   - **Currency:** "Existing monetary values keep their original currencies. Trestle does not automatically convert them."
   - **Locale** changes affect presentation only and need no warning. **Language** changes affect future fallback rendering, not communications already sent.
5. **Effective-settings debugging in the platform admin.** Pick an organization and a user, and see each setting's effective value and source. It evaluates the real resolution rules and changes nothing, the same way the Effective Access Explorer works for permissions.
6. **Schedule impact.** When scheduling is enabled, list the schedules that follow organization local time, separately from schedules with an explicit time zone.
7. **i18n status** when internationalization is declared: available languages and how complete each is. Translation catalogs stay in application source. The admin never becomes a translation editor.

Pickers, which apply everywhere:
- Time-zone search matches cities, regions, abbreviations and IANA names (Seattle, Pacific, PST and `America/Los_Angeles` all find the same zone) and stores the IANA identifier.
- Locales show friendly names and store canonical identifiers.
- Currencies show code and name, for example `USD — US Dollar`.
- Flags are never the primary way to represent a language, locale or currency.

Not planned: platform-side changes to a tenant's regional settings. The platform stays read-only. If a recovery mutation is ever needed, it needs an explicit platform permission, step-up authentication and a reason, and it is specified separately.

## 3. Acceptance criteria

The remaining work is complete when a clean generated application can:

1. let a user override their language, locale and time zone where permitted;
2. show each setting's effective value and source;
3. preview date, time, number, percentage and money formatting before saving;
4. warn before organization time-zone or currency changes;
5. identify the schedules that depend on organization local time;
6. prove that a change to the organization default doesn't affect schedules with an explicit time zone;
7. explain a user's effective regional context in the platform admin;
8. prove that changing settings never reinterprets historical timestamps, civil dates or monetary values.

The shipped behavior must keep passing:
- regional-setting changes produce the audit event;
- authorization and forced RLS deny cross-tenant access;
- the platform can read regional settings but not write them.

## 4. Still to write

A full locale, time and money specification covering:
- civil dates versus instants;
- DST behavior;
- exact money arithmetic;
- persistence;
- scheduling semantics.

The draft that was supplied is only an overview, so this document keeps just its principle. Write the full specification before marking those contracts implemented.
</content>
</invoke>
