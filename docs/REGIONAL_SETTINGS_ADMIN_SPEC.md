# TrestleJS Regional Settings Administration Specification

**Status:** Draft v0.1\
**Scope:** Customer-organization, user, and platform-admin surfaces for
locale, language, time zone, currency, and internationalization
configuration.\
**Parent specification:** TrestleJS Locale, Time, Money, and
Internationalization Specification

------------------------------------------------------------------------

## 1. Purpose

Trestle's locale, temporal, and monetary primitives require
administrative surfaces where authorized users can inspect and configure
the regional defaults that affect presentation and organization-relative
behavior.

The UI must preserve the distinction between:

-   application defaults;
-   organization defaults;
-   user preferences;
-   canonical persisted values; and
-   resolved effective values.

The settings surface is not merely cosmetic. Organization time zone can
affect organization-relative schedules and business-time presentation,
while locale and language affect presentation and communications.

The governing rule is:

> **Regional settings configure defaults and presentation context. They
> never reinterpret canonical historical data.**

------------------------------------------------------------------------

## 2. Surfaces

Regional settings belong in three distinct places:

``` text
apps/app
  Settings
    Organization
      Regional

apps/app
  Account
    Language & Region

apps/admin
  Organizations
    <organization>
      Regional
```

Application-wide defaults remain source/setup-owned and are configured
through:

``` text
trestle setup
```

They are not ordinarily mutable through the deployed platform admin
application.

This preserves Trestle's existing boundary:

``` text
setup console → application/deployment configuration
customer app  → tenant-owned configuration
admin app     → inspect and safely operate runtime state
```

------------------------------------------------------------------------

## 3. Organization Regional Settings

Authorized organization administrators receive:

``` text
Settings
└── Organization
    └── Regional
```

The page should contain four primary settings.

### Time zone

Example:

``` text
Time zone
America/Los_Angeles

Used for organization-relative dates, schedules,
reports, and default communication times.
```

Selection uses a searchable list of canonical IANA time zones.

The UI may additionally show a friendly current representation:

``` text
America/Los_Angeles
Pacific Time
Current offset: UTC−07:00
```

The offset is informational only. The persisted value remains the IANA
identifier.

### Locale

Example:

``` text
Locale
English (United States) — en-US

Controls date, number, percentage, and currency formatting.
```

The persisted value uses a BCP 47 locale identifier.

### Default language

Displayed when application internationalization is enabled:

``` text
Default language
English

Used when a member or recipient has not selected a language.
```

If internationalization is disabled, the page may display the
application language as read-only rather than presenting a meaningless
control.

### Default currency

Example:

``` text
Default currency
USD — US Dollar

Used as the default currency for newly created monetary
values where the product permits a default.
```

The UI must make clear:

> Changing the default currency does not convert or reinterpret existing
> monetary values.

Currency selection uses supported ISO 4217 codes.

------------------------------------------------------------------------

## 4. User Language & Region

Individual users receive:

``` text
Account
└── Language & Region
```

Recommended settings:

``` text
Language
English

Locale
English (United States)

Time zone
America/Los_Angeles
```

Each setting should support an organization-default state where
appropriate:

``` text
Time zone
Use organization default
America/Los_Angeles
```

The UI should distinguish:

``` text
Your preference
Organization default
Application default
```

without requiring the user to understand the underlying resolution
algorithm.

Currency should not normally be a user preference unless the generated
application explicitly supports display-currency selection.

------------------------------------------------------------------------

## 5. Resolution Preview

The organization Regional page should include a compact preview showing
the practical effect of the current settings.

Example:

``` text
Preview

Date & time
Sep 22, 2026, 4:14 PM

Date
September 22, 2026

Number
1,234,567.89

Currency
$12,345.67

Percentage
12.5%
```

Changing locale or time zone updates the preview before save.

This gives users immediate feedback and prevents settings such as
`en-US` from becoming opaque configuration codes.

------------------------------------------------------------------------

## 6. Effective Settings and Provenance

Where useful, the interface should expose the effective value and its
source.

Example:

``` text
Time zone
America/Los_Angeles

Source
Organization setting
```

If the organization has never configured a value:

``` text
Time zone
America/Los_Angeles

Source
Application default
```

For a user:

``` text
Time zone
America/New_York

Source
Your preference

Organization default
America/Los_Angeles
```

This corresponds directly to the Trestle resolution hierarchy:

``` text
explicit operation override
        ↓
user preference
        ↓
organization default
        ↓
application default
```

------------------------------------------------------------------------

## 7. Save Behavior

Regional settings should save explicitly rather than mutating
immediately when selection changes.

Before saving, the server validates:

-   IANA time-zone identifier;
-   supported BCP 47 locale;
-   supported language;
-   supported ISO 4217 currency;
-   caller authorization;
-   organization context.

Successful organization changes emit semantic audit events.

Recommended event:

``` text
organization.regional_settings.updated
```

Safe audit data may include:

``` json
{
  "timeZone": {
    "from": "America/New_York",
    "to": "America/Los_Angeles"
  },
  "locale": {
    "from": "en-US",
    "to": "en-US"
  }
}
```

The event must not imply that historical records were rewritten.

------------------------------------------------------------------------

## 8. Change Warnings

Not all regional settings require the same warning.

### Time-zone change

A time-zone change may affect future organization-relative schedules.

Before saving a changed organization time zone, the UI should state:

> Future schedules that follow organization local time may occur at a
> different instant after this change. Historical timestamps are not
> changed.

If Trestle can determine affected recurring schedules, show a count and
provide a review action:

``` text
3 recurring schedules use the organization time zone.

Review schedules
```

The setting must not silently rewrite explicitly zoned schedules.

### Currency change

Before changing the organization default currency:

> Existing monetary values keep their original currencies. Trestle does
> not automatically convert them.

### Locale change

Locale changes affect presentation only and normally require no
destructive warning.

### Language change

Changing organization default language affects future fallback
rendering, not previously rendered or delivered communications.

------------------------------------------------------------------------

## 9. Platform Admin Organization View

The platform admin application should expose regional state on an
organization's detail page.

Recommended placement:

``` text
Organizations
└── Acme
    ├── Overview
    ├── Members
    ├── Subscription
    ├── Access
    ├── Regional
    └── Audit
```

The Regional view shows:

``` text
Application defaults

Language      English
Locale        en-US
Time zone     UTC
Currency      USD

Organization defaults

Language      English
Locale        en-US
Time zone     America/Los_Angeles
Currency      USD

Effective organization context

Language      English
Locale        en-US
Time zone     America/Los_Angeles
Currency      USD
```

Each effective value should identify its source.

------------------------------------------------------------------------

## 10. Platform Admin Mutation Policy

Platform operators should not receive unrestricted regional-settings
mutation merely because they can inspect an organization.

Default platform behavior is read-only.

Mutation requires one of:

1.  an explicitly authorized support context acting with tenant
    authority; or
2.  a dedicated platform recovery permission for regional configuration.

Recommended platform permission:

``` text
platform.organizations.regional.read
```

Optional recovery permission:

``` text
platform.organizations.regional.recover
```

A platform recovery mutation requires:

-   step-up authentication;
-   explicit reason;
-   organization identification;
-   before/after preview;
-   semantic audit event.

Selecting an organization in `apps/admin` never grants this authority.

------------------------------------------------------------------------

## 11. Regional Debugging

The platform admin Regional view should provide a small diagnostic tool
for resolving regional context.

Example:

``` text
Resolve regional context

Organization    Acme
User            Sarah Chen

                         Effective                 Source
Language                 Spanish                   User preference
Locale                   en-US                     Organization default
Time zone                 America/New_York          User preference
Currency                  USD                       Organization default
```

This tool evaluates the real resolution policy but does not mutate
state.

It is analogous to Trestle's Effective Access Explorer: an explanation
surface over authoritative policy.

------------------------------------------------------------------------

## 12. Schedule Impact Inspection

Because organization time-zone changes can affect wall-clock scheduling,
the admin/customer surface should support inspecting dependent schedules
when the scheduling capability is enabled.

Example:

``` text
Schedules using organization time zone

Daily operations digest
09:00 organization time

Weekly billing summary
Monday 08:00 organization time

Customer reminder sweep
17:00 organization time
```

The system distinguishes these from explicitly zoned schedules:

``` text
Monthly New York report
09:00 America/New_York
```

An explicitly zoned schedule does not change merely because the
organization's default time zone changes.

------------------------------------------------------------------------

## 13. Internationalization Status

When i18n is declared, the organization and platform views may show:

``` text
Internationalization

Status              Verified
Application language English
Fallback language    English

Available languages
English              Complete
Spanish              Complete
French               94%
```

Translation-catalog management remains application-owned source unless a
future translation-management integration is explicitly enabled.

The runtime admin must not become a generic editor for application
translation source.

------------------------------------------------------------------------

## 14. Capability-Aware UI

The page adapts to application capabilities.

If multi-currency behavior is not used, default currency may remain
visible as application metadata but need not occupy prominent customer
settings.

If i18n is disabled:

``` text
Language
English
Application default
```

may be read-only.

If organization-level regional customization is disabled, the customer
settings page is absent and application defaults apply.

The admin view can still display the resolved context for diagnosis.

------------------------------------------------------------------------

## 15. Customer Permissions

Recommended tenant permissions:

``` text
organization.settings.regional.read
organization.settings.regional.manage
```

Ordinary users may always read their own effective regional context and
manage their own permitted preferences.

User preference management should use an account-level permission/policy
rather than organization-administrator authority.

Changing organization regional settings does not require platform
authority.

------------------------------------------------------------------------

## 16. API Contract

A safe organization settings projection might be:

``` ts
type OrganizationRegionalSettings = {
  configured: {
    locale: string | null;
    language: string | null;
    timeZone: string | null;
    currency: string | null;
  };

  effective: {
    locale: {
      value: string;
      source: "organization" | "application";
    };
    language: {
      value: string;
      source: "organization" | "application";
    };
    timeZone: {
      value: string;
      source: "organization" | "application";
    };
    currency: {
      value: string;
      source: "organization" | "application";
    };
  };
};
```

User regional settings use the equivalent hierarchy with `user`,
`organization`, and `application` provenance.

Read contracts should return canonical identifiers. Friendly labels are
presentation concerns.

------------------------------------------------------------------------

## 17. Accessibility and Ergonomics

Time-zone selection must not require users to know an IANA identifier.

Search should match:

``` text
Seattle
Pacific
Los Angeles
America/Los_Angeles
PST
PDT
```

while persisting:

``` text
America/Los_Angeles
```

Locale selection should present friendly names while preserving
canonical identifiers.

Currency selection should show code and name:

``` text
USD — US Dollar
CAD — Canadian Dollar
EUR — Euro
```

The UI must not rely on flags as the primary representation of language,
locale, or currency.

------------------------------------------------------------------------

## 18. Admin Overview Integration

Regional settings generally do not belong as a permanent card on the
platform Overview dashboard.

They become operationally important when something requires attention.

Examples:

``` text
2 organizations have invalid legacy time-zone configuration
1 recurring schedule could not resolve its time zone
French translation catalog failed verification
Organization currency configuration is inconsistent
```

These appear in **Needs attention** and link to the relevant
organization or system-health view.

Healthy regional configuration recedes.

------------------------------------------------------------------------

## 19. Setup Integration

Application defaults remain managed by:

``` text
pnpm exec trestle setup
```

The setup console should configure:

``` text
Application language
Default locale
Default time zone
Default currency
Internationalization capability
Supported languages
```

The deployed platform admin may inspect these values but does not modify
SetupPlan or generated application configuration.

If application-level configuration is invalid, admin should display
remediation such as:

``` text
Application default time zone is invalid.

Run:
pnpm exec trestle setup
```

rather than accepting deployment configuration secrets or source-level
changes.

------------------------------------------------------------------------

## 20. Audit Events

Recommended semantic events:

``` text
organization.regional_settings.updated
user.regional_preferences.updated
platform.organization_regional_settings.recovered
```

Audit records include:

-   principal;
-   principal type;
-   organization;
-   safe before/after values;
-   reason when required;
-   support session when applicable;
-   correlation ID;
-   environment;
-   occurrence instant.

They do not record localized display strings as authoritative values.

------------------------------------------------------------------------

## 21. Testing

Required tests include:

-   organization setting persistence;
-   user override persistence;
-   application → organization → user resolution;
-   invalid IANA time-zone rejection;
-   invalid locale rejection;
-   invalid currency rejection;
-   customer authorization;
-   platform read authorization;
-   platform mutation denial without recovery/support authority;
-   cross-tenant RLS denial;
-   resolution provenance;
-   locale preview formatting;
-   time-zone preview formatting;
-   organization time-zone change warning;
-   explicitly zoned schedules remaining unchanged;
-   organization-relative schedules resolving under the new default;
-   currency change preserving historical monetary values;
-   i18n-disabled UI behavior;
-   audit generation;
-   no historical timestamp mutation;
-   no historical monetary reinterpretation.

Browser tests should verify both customer and platform-admin surfaces.

------------------------------------------------------------------------

## 22. Acceptance Criteria

The regional administration surface is complete when a clean generated
application can:

1.  Set application defaults through `trestle setup`.
2.  Allow an authorized organization administrator to configure
    organization locale and time zone.
3.  Configure organization language when i18n is enabled.
4.  Configure default currency where supported.
5.  Allow a user to override permitted language, locale, and time-zone
    preferences.
6.  Show the effective value and provenance for each regional setting.
7.  Preview date, time, number, percentage, and money formatting before
    save.
8.  Warn appropriately before organization time-zone or currency
    changes.
9.  Identify schedules dependent on organization local time.
10. Prove explicitly zoned schedules are unaffected by an
    organization-default change.
11. Show regional configuration read-only to an authorized platform
    operator.
12. Explain a user's effective regional context through the platform
    admin.
13. Require explicit recovery authority, step-up, and reason for
    platform-side mutation.
14. Record semantic audit evidence for every regional-setting mutation.
15. Prove cross-tenant access is denied by authorization and forced RLS.
16. Prove changing settings does not reinterpret canonical historical
    timestamps, civil dates, or monetary values.

------------------------------------------------------------------------

## 23. Design Principle

The regional settings UI should make a sophisticated underlying model
feel ordinary.

A customer should experience:

``` text
Time zone
Pacific Time

Locale
English (United States)

Currency
USD
```

while Trestle preserves:

``` text
IANA time-zone identity
BCP 47 locale identity
ISO currency identity
resolution provenance
canonical historical values
DST semantics
tenant authorization
forced RLS
semantic audit
```

The complexity belongs in the substrate, not in the settings form.
