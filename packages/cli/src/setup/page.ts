const styles = String.raw`
:root { color-scheme: light dark; --bg: #f6f7f9; --panel: #fff; --text: #1b1f24; --muted: #5d6673; --line: #dde1e6; --accent: #2156d9; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --chip: #eef1f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --panel: #171b21; --text: #e6e9ed; --muted: #9aa4b2; --line: #2b313a; --accent: #6b9bff; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --chip: #222831; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
header h1 { font-size: 16px; margin: 0; }
header .meta { color: var(--muted); font-size: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
@media (max-width: 1100px) { .layout { grid-template-columns: 200px minmax(0, 1fr); } aside.status { grid-column: 1 / -1; } }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
nav ol { list-style: none; margin: 0; padding: 0; }
nav button { width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: 7px 10px; border-radius: 6px; cursor: pointer; font: inherit; }
nav button:hover { background: var(--chip); }
nav button.active { background: var(--accent); color: #fff; }
nav .num { display: inline-block; width: 22px; color: inherit; opacity: .7; }
section.panel, aside.status > div { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
aside.status > div + div { margin-top: 16px; }
h2 { font-size: 18px; margin: 0 0 4px; }
h3 { font-size: 14px; margin: 20px 0 8px; }
p.lead { color: var(--muted); margin: 0 0 16px; }
.field { margin: 10px 0; }
.field label.title { display: block; font-weight: 600; margin-bottom: 4px; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.choice { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-width: 150px; }
.choice input { margin-top: 3px; }
.choice small { display: block; color: var(--muted); }
input[type=text], input[type=number], input[type=password], select { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); }
input[type=password] { width: 100%; min-width: 160px; }
input[type=text] { width: min(100%, 360px); }
button.btn { font: inherit; border: 1px solid var(--line); background: var(--chip); color: var(--text); padding: 6px 12px; border-radius: 6px; cursor: pointer; }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.btn.danger { border-color: var(--bad); color: var(--bad); }
button.btn:disabled { opacity: .5; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; white-space: nowrap; }
.chip.ok, .chip.set, .chip.configured, .chip.deployed, .chip.verified, .chip.reachable, .chip.available, .chip.pass { color: var(--ok); }
.chip.missing, .chip.declared, .chip.unauthorized, .chip.unreachable, .chip.fail, .chip.blocked, .chip.delete, .chip.locked { color: var(--bad); }
.chip.warn, .chip.update, .chip.create, .chip.unknown, .chip.not_configured { color: var(--warn); }
.note { border-left: 3px solid var(--accent); background: var(--chip); padding: 8px 12px; border-radius: 4px; margin: 12px 0; color: var(--text); }
.note.warn { border-color: var(--warn); }
.note.bad { border-color: var(--bad); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.muted { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.footer { display: flex; justify-content: space-between; margin-top: 20px; }
#toast { position: fixed; bottom: 16px; right: 16px; max-width: 420px; }
#toast div { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-top: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
ul.issues { margin: 6px 0; padding-left: 18px; color: var(--bad); }
`;

const script = String.raw`
(function () {
  "use strict";
  var csrf = document.querySelector('meta[name="trestle-csrf"]').getAttribute("content");
  var state = null, draft = null, dirty = false, step = 0, credEnv = null, diff = null, applyResult = null, planIssues = [];
  var root = document.getElementById("app");

  function h(tag, attrs) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else if (key === "checked" || key === "disabled" || key === "value") node[key] = value;
      else node.setAttribute(key, value);
    });
    children.flat(3).forEach(function (child) {
      if (child === undefined || child === null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }
  function chip(value, label) { return h("span", { class: "chip " + value, text: label || value }); }
  function toast(message, kind) {
    var box = document.getElementById("toast");
    var item = h("div", { class: kind || "", text: message });
    box.appendChild(item);
    setTimeout(function () { item.remove(); }, 5000);
  }
  function api(method, url, body) {
    var init = { method: method, headers: { "x-trestle-csrf": csrf }, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.status === 401) { root.replaceChildren(h("section", { class: "panel" }, h("h2", { text: "Setup session ended" }), h("p", { class: "lead", text: "Restart pnpm exec trestle setup to open a new session." }))); }
        if (!response.ok) { var error = new Error(data.message || ("HTTP " + response.status)); error.data = data; throw error; }
        return data;
      });
    });
  }
  function envState(name) { return state.environmentStates.filter(function (item) { return item.environment === name; })[0]; }
  function markDirty() { dirty = true; renderHeader(); }
  function ensure(key, fallback) { if (!draft[key]) draft[key] = fallback; return draft[key]; }

  function checkbox(label, get, set, help, disabled) {
    return h("label", { class: "choice" }, h("input", { type: "checkbox", checked: Boolean(get()), disabled: disabled, onchange: function (event) { set(event.target.checked); markDirty(); render(); } }), h("span", {}, label, help ? h("small", { text: help }) : null));
  }
  function radios(name, options, get, set) {
    return h("div", { class: "choices" }, options.map(function (option) {
      return h("label", { class: "choice" }, h("input", { type: "radio", name: name, value: option[0], checked: get() === option[0], onchange: function () { set(option[0]); markDirty(); render(); } }), h("span", {}, option[1], option[2] ? h("small", { text: option[2] }) : null));
    }));
  }
  function field(title) { return h("div", { class: "field" }, h("label", { class: "title", text: title }), Array.prototype.slice.call(arguments, 1)); }

  function secretsPanel(names, note) {
    var env = envState(credEnv);
    var rows = env.secrets.filter(function (secret) { return names.indexOf(secret.name) !== -1; });
    var undeclared = names.filter(function (name) { return !env.secrets.some(function (secret) { return secret.name === name; }); });
    return h("div", {},
      h("h3", { text: "Encrypted credentials (" + credEnv + ")" }),
      note ? h("p", { class: "muted", text: note }) : null,
      env.credentials.status === "locked" ? h("div", { class: "note bad", text: "The " + credEnv + " master key is unavailable. Restore config/credentials key or restart with TRESTLE_MASTER_KEY." }) : null,
      state.planOnly ? h("div", { class: "note warn", text: "Credential changes are disabled in --plan-only mode." }) : null,
      rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Secret", "Status", "Fingerprint", "Set value"].map(function (label) { return h("th", { text: label }); }))),
        h("tbody", {}, rows.map(function (secret) {
          var input = h("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: secret.status === "set" ? "replace value" : "enter value", disabled: state.planOnly });
          var submit = h("button", { class: "btn", text: "Encrypt", disabled: state.planOnly, onclick: function () {
            var value = input.value;
            input.value = "";
            if (!value) { toast("Enter a value first", "warn"); return; }
            submit.disabled = true;
            api("POST", "/api/secrets", { environment: credEnv, name: secret.name, value: value }).then(function (result) {
              value = "";
              toast(result.name + " encrypted for " + result.environment + " (" + result.fingerprint + ")");
              return refresh();
            }).catch(function (error) { value = ""; toast(error.message, "bad"); submit.disabled = false; });
          } });
          return h("tr", {}, h("td", { class: "mono", text: secret.name + (secret.required ? "" : " (optional)") }), h("td", {}, chip(secret.status)), h("td", { class: "mono", text: secret.fingerprint || "—" }), h("td", {}, h("div", { class: "row" }, input, submit)));
        }))) : null,
      undeclared.length ? h("div", { class: "note warn", text: "Not declared in .trestle/project.yaml secrets: " + undeclared.join(", ") + ". Declare them before storing values." }) : null);
  }
  function connectionTest(provider) {
    var env = envState(credEnv);
    var last = env.connections[provider];
    return h("div", { class: "row" }, h("button", { class: "btn", text: "Test " + provider + " connection (" + credEnv + ")", onclick: function (event) {
      event.target.disabled = true;
      api("POST", "/api/connections/test", { environment: credEnv, provider: provider }).then(function (result) { toast(provider + ": " + result.status, result.ok ? "" : "warn"); return refresh(); }).catch(function (error) { toast(error.message, "bad"); event.target.disabled = false; });
    } }), last ? chip(last.status) : h("span", { class: "muted", text: "not tested" }), last ? h("span", { class: "muted", text: last.checkedAt }) : null);
  }
  function providers() { return ensure("providers", { email: "disabled", payments: "disabled" }); }

  var steps = [
    { title: "Identity & environments", render: function () {
      return [h("p", { class: "lead", text: "Name the application and choose the environments it deploys to. Domains and origins are configured per environment in the Worker and Pages configuration." }),
        field("Project name", h("input", { type: "text", value: draft.project.name, oninput: function (event) { draft.project.name = event.target.value; markDirty(); } })),
        field("Environments", h("div", { class: "choices" }, ["local", "preview", "staging", "production"].map(function (name) {
          return checkbox(name, function () { return draft.environments.indexOf(name) !== -1; }, function (on) {
            draft.environments = ["local", "preview", "staging", "production"].filter(function (item) { return item === name ? on : draft.environments.indexOf(item) !== -1; });
          }, name === "local" ? "required" : null, name === "local");
        })))];
    } },
    { title: "Surfaces", render: function () {
      var apps = state.manifest.apps;
      function present(name) { return apps[name] ? "source " + apps[name] : "not present in this project"; }
      return [h("p", { class: "lead", text: "Choose the public site, customer application, API Worker, and platform admin surfaces." }),
        h("div", { class: "choices" },
          checkbox("Public site", function () { return draft.apps.site; }, function (on) { draft.apps.site = on; }, present("site")),
          checkbox("Customer app", function () { return draft.apps.app; }, function (on) { draft.apps.app = on; }, present("app")),
          checkbox("API Worker", function () { return draft.apps.worker; }, function (on) { draft.apps.worker = on; }, present("worker")),
          checkbox("Platform admin", function () { return draft.apps.admin; }, function (on) { draft.apps.admin = on; if (on) draft.capabilities.admin = true; }, present("admin"))),
        h("div", { class: "note", text: "The platform admin is a separate application with its own origin and platform authentication. Enabling it here declares the capability; apply only restores missing registrations and never overwrites application-owned source." })];
    } },
    { title: "Authentication & organizations", render: function () {
      var a = ensure("authentication", { passkeys: "better-auth", twoFactor: "better-auth" });
      var neither = a.passkeys === "disabled" && a.twoFactor === "disabled";
      return [h("p", { class: "lead", text: "Better Auth owns sign-in, passkeys, and two-factor protocols. Trestle records how each session was verified and requires fresh, sufficient evidence for sensitive actions." }),
        h("table", {}, h("tbody", {}, h("tr", {}, h("th", { text: "Password" }), h("td", { text: "Better Auth (always on)" })), h("tr", {}, h("th", { text: "Tenancy" }), h("td", { text: draft.tenancy.model + " (" + draft.tenancy.enforcement + ")" })), h("tr", {}, h("th", { text: "Tenant roles" }), h("td", { text: "owner, admin, billing_admin, member, viewer" })))),
        field("Passkeys", radios("passkeys", [["disabled", "Disabled"], ["better-auth", "Better Auth", "WebAuthn platform authenticators and security keys (phishing-resistant)"]], function () { return a.passkeys; }, function (value) { a.passkeys = value; })),
        field("Two-factor", radios("twoFactor", [["disabled", "Disabled"], ["better-auth", "Better Auth", "authenticator apps (TOTP) and backup codes"]], function () { return a.twoFactor; }, function (value) { a.twoFactor = value; })),
        neither && draft.capabilities.admin ? h("div", { class: "note warn", text: "The platform admin requires passkeys or two-factor: operators must verify with a second factor for sensitive actions outside local." }) : null,
        secretsPanel(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"])];
    } },
    { title: "Enterprise identity", render: function () {
      var i = ensure("identity", { sso: "disabled", directory: "disabled" });
      return [h("p", { class: "lead", text: "Enterprise SSO and directory provisioning supply identities and lifecycle facts. Group mappings grant organization or application roles only, and only the assignments each source created; platform roles are never provisioned." }),
        field("SSO", radios("sso", [["disabled", "Disabled"], ["better-auth", "Better Auth", "self-hosted OIDC and SAML"], ["workos", "WorkOS", "managed connections and admin portal"]], function () { return i.sso; }, function (value) {
          i.sso = value;
          if (value === "disabled") i.directory = "disabled";
          if (value === "better-auth" && i.directory === "workos") i.directory = "disabled";
          if (value === "workos" && i.directory === "better-auth-scim") i.directory = "disabled";
        })),
        field("Directory provisioning", radios("directory", [["disabled", "Disabled"], ["better-auth-scim", "Better Auth SCIM", i.sso === "better-auth" ? "self-hosted SCIM 2.0; needs interactive transactions" : "requires Better Auth SSO"], ["workos", "WorkOS Directory Sync", i.sso === "workos" ? "managed directory events" : "requires WorkOS SSO"]], function () { return i.directory; }, function (value) {
          if ((value === "better-auth-scim" && i.sso !== "better-auth") || (value === "workos" && i.sso !== "workos")) { toast("Choose the matching SSO provider first", "warn"); return; }
          i.directory = value;
        })),
        i.directory === "better-auth-scim" ? h("div", { class: "note warn", text: "Self-hosted SCIM is verified only after a real create/update/deactivate transaction test on each environment's database driver: pnpm exec trestle identity verify-scim --env <env>. neon-http cannot pass it." }) : null,
        i.sso === "workos" ? [secretsPanel(i.directory === "workos" ? ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_WEBHOOK_SECRET"] : ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"]), connectionTest("workos")] : null];
    } },
    { title: "Email", render: function () {
      var p = providers();
      return [h("p", { class: "lead", text: "Transactional email: disabled, captured locally, or delivered through Resend." }),
        radios("email", [["disabled", "Disabled", "no email claims or routes"], ["local", "Local capture", "trestle email list"], ["resend", "Resend", "staging and production delivery"]], function () { return p.email; }, function (value) { p.email = value; }),
        p.email === "resend" ? [secretsPanel(["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]), connectionTest("resend")] : null];
    } },
    { title: "Payments", render: function () {
      var p = providers();
      return [h("p", { class: "lead", text: "Payments normalize into the canonical subscription projection regardless of provider." }),
        radios("payments", [["disabled", "Disabled"], ["local", "Local", "no provider account"], ["stripe", "Stripe", "golden-path adapter"], ["lago", "Lago", "usage-based billing"]], function () { return p.payments; }, function (value) {
          p.payments = value;
          if (value === "lago") { var c = ensure("commercial", { plans: true, usage: false }); c.plans = true; }
        }),
        p.payments === "stripe" ? [secretsPanel(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]), connectionTest("stripe")] : null,
        p.payments === "lago" ? [secretsPanel(["LAGO_API_KEY"], "Lago requires commercial plans. Declare LAGO_API_KEY as a Worker secret in .trestle/project.yaml."), connectionTest("lago")] : null];
    } },
    { title: "Plans & entitlements", render: function () {
      var c = ensure("commercial", { plans: false, usage: false });
      var lago = draft.providers && draft.providers.payments === "lago";
      return [h("p", { class: "lead", text: "Versioned plans grant features and quotas; effective entitlements are explainable with provenance." }),
        h("div", { class: "choices" },
          checkbox("Plans & entitlements", function () { return c.plans; }, function (on) { c.plans = on; }, lago ? "required by Lago" : "versioned plans, overrides, quotas", lago && c.plans),
          checkbox("Usage metering", function () { return c.usage; }, function (on) { c.usage = on; if (!on) providers().metering = "native"; }, "allowances and usage records")),
        c.usage ? [field("Metering provider", radios("metering", [["native", "Native", "usage_aggregate projection in PostgreSQL"], ["openmeter", "OpenMeter", "metering and balances; any payments provider"], ["lago", "Lago", lago ? "usage rated inside Lago billing" : "requires Lago payments"]], function () { return providers().metering || "native"; }, function (value) {
            if (value === "lago" && !lago) { toast("Lago metering requires Lago payments", "warn"); return; }
            providers().metering = value;
          })),
          h("div", { class: "note", text: "Providers report usage and balances into the local entitlement projection. Request authorization never calls a metering provider." }),
          providers().metering === "openmeter" ? [secretsPanel(["OPENMETER_API_KEY"]), connectionTest("openmeter")] : null,
          providers().metering === "lago" ? [secretsPanel(["LAGO_API_KEY"]), connectionTest("lago")] : null] : null];
    } },
    { title: "Delivery", render: function () {
      var c = ensure("communications", { webhooks: false, notifications: false });
      var p = providers();
      return [h("p", { class: "lead", text: "Outbound webhooks and notifications start from the transactional outbox. The provider only dispatches after the commit; Trestle keeps the event catalog, subscriptions, and delivery history." }),
        h("div", { class: "choices" },
          checkbox("Outbound webhooks", function () { return c.webhooks; }, function (on) { c.webhooks = on; if (!on) p.webhooks = "native"; }, "tenant endpoints, signed deliveries"),
          checkbox("Notifications", function () { return c.notifications; }, function (on) { c.notifications = on; }, "in-app inbox, preferences, email")),
        c.webhooks ? field("Webhook dispatch", radios("webhooks", [["native", "Native", "Worker delivery with Standard Webhooks signatures"], ["svix", "Svix", "managed retries, replay, and consumer portal"]], function () { return p.webhooks || "native"; }, function (value) { p.webhooks = value; })) : null,
        c.webhooks && p.webhooks === "svix" ? [secretsPanel(["SVIX_API_KEY"], "Set SVIX_SERVER_URL in the credentials only for a self-hosted or regional Svix server."), connectionTest("svix")] : null];
    } },
    { title: "Database", render: function () {
      return [h("p", { class: "lead", text: "PostgreSQL is canonical state. Local development uses Docker Compose; remote environments default to Neon." }),
        radios("database", [["neon", "Neon", "serverless PostgreSQL branches"], ["postgresql", "PostgreSQL", "self-managed connection"]], function () { return draft.database.provider; }, function (value) { draft.database.provider = value; }),
        secretsPanel(["DATABASE_URL", "DATABASE_DRIVER", "DATABASE_MIGRATION_URL", "NEON_API_KEY"]),
        draft.database.provider === "neon" ? connectionTest("neon") : null];
    } },
    { title: "Async processing", render: function () {
      return [h("p", { class: "lead", text: "Committed domain changes flow through the outbox. Queues distribute retryable work, Workflows own durable multi-step progression, and failures land in a DLQ." }),
        h("div", { class: "choices" },
          checkbox("Queues", function () { return draft.capabilities.queues; }, function (on) { draft.capabilities.queues = on; }, "binding QUEUE + DLQ"),
          checkbox("Workflows", function () { return draft.capabilities.workflows; }, function (on) { draft.capabilities.workflows = on; }, "binding WORKFLOW"),
          checkbox("Durable Objects", function () { return draft.capabilities.durableObjects; }, function (on) { draft.capabilities.durableObjects = on; }, "coordinated per-entity state")),
        h("div", { class: "note", text: "Inspect dead-lettered messages with pnpm exec trestle queue dlq list --env staging." })];
    } },
    { title: "Artifacts", render: function () {
      var a = ensure("artifacts", { storage: "local", retentionDays: 30 });
      return [h("p", { class: "lead", text: "Generated files and uploads are stored outside PostgreSQL; metadata and ownership stay in the database." }),
        radios("artifacts", [["local", "Local", "filesystem adapter"], ["r2", "Cloudflare R2", "binding ARTIFACTS"]], function () { return a.storage; }, function (value) { a.storage = value; if (value === "r2") draft.capabilities.r2 = true; }),
        field("Retention (days)", h("input", { type: "number", min: "1", max: "3650", value: String(a.retentionDays), oninput: function (event) { a.retentionDays = Number(event.target.value); markDirty(); } }))];
    } },
    { title: "Regional defaults", render: function () {
      var r = ensure("regional", { language: "en", locale: "en-US", timeZone: "UTC", currency: "USD", organizationSettings: true, i18n: { enabled: false, languages: ["en"] } });
      var zones = h("datalist", { id: "trestle-time-zones" }, (Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []).concat(["UTC"]).map(function (zone) { return h("option", { value: zone }); }));
      function text(label, key, placeholder, extra) {
        return field(label, h("input", Object.assign({ type: "text", value: r[key], placeholder: placeholder, oninput: function (event) { r[key] = event.target.value.trim(); markDirty(); } }, extra || {})));
      }
      return [h("p", { class: "lead", text: "Application defaults for language, formatting, time, and money. Organizations and users may override them in the app; historical timestamps and monetary values are never reinterpreted." }),
        text("Application language", "language", "en"),
        text("Default locale (BCP 47)", "locale", "en-US"),
        zones, text("Default time zone (IANA)", "timeZone", "America/Los_Angeles", { list: "trestle-time-zones" }),
        text("Default currency (ISO 4217)", "currency", "USD"),
        h("div", { class: "choices" },
          checkbox("Organization regional settings", function () { return r.organizationSettings; }, function (on) { r.organizationSettings = on; }, "organization administrators may override these defaults"),
          checkbox("Internationalization", function () { return r.i18n.enabled; }, function (on) { r.i18n.enabled = on; if (r.i18n.languages.indexOf(r.language) < 0) r.i18n.languages.unshift(r.language); }, "translated application text")),
        r.i18n.enabled ? field("Supported languages", h("input", { type: "text", value: r.i18n.languages.join(", "), placeholder: "en, es", oninput: function (event) { r.i18n.languages = event.target.value.split(",").map(function (value) { return value.trim().toLowerCase(); }).filter(Boolean); markDirty(); } })) : null];
    } },
    { title: "Access control", render: function () {
      var a = ensure("access", { customRoles: false, serviceAccounts: false, apiKeys: false });
      return [h("p", { class: "lead", text: "Roles resolve to deterministic permissions. Service accounts are non-human principals; API keys only reduce their authority." }),
        h("div", { class: "choices" },
          checkbox("Custom roles", function () { return a.customRoles; }, function (on) { a.customRoles = on; }, "tenant-defined roles"),
          checkbox("Service accounts", function () { return a.serviceAccounts; }, function (on) { a.serviceAccounts = on; if (!on) a.apiKeys = false; }, "non-human principals"),
          checkbox("API keys", function () { return a.apiKeys; }, function (on) { a.apiKeys = on; }, a.serviceAccounts ? "scoped, hashed, rotatable" : "requires service accounts", !a.serviceAccounts))];
    } },
    { title: "Deployment environments", render: function () {
      var d = state.deployment;
      return [h("p", { class: "lead", text: "GitHub Actions verifies and deploys; Cloudflare hosts the Workers and static assets. This step is read-only." }),
        h("h3", { text: "GitHub workflows" }), d.githubWorkflows.length ? h("div", { class: "row" }, d.githubWorkflows.map(function (file) { return chip("ok", file); })) : h("p", { class: "muted", text: "No workflows found in .github/workflows." }),
        h("h3", { text: "Cloudflare configuration" }), h("div", { class: "row" }, Object.keys(d.cloudflare).map(function (name) { return chip(d.cloudflare[name] ? "ok" : "missing", name + (d.cloudflare[name] ? " wrangler.jsonc" : " no wrangler.jsonc")); })),
        h("h3", { text: "Environments" }),
        h("table", {}, h("thead", {}, h("tr", {}, ["Environment", "Credentials", "Required secrets set", "Capabilities needing setup"].map(function (label) { return h("th", { text: label }); }))),
          h("tbody", {}, state.environmentStates.map(function (env) {
            var required = env.secrets.filter(function (secret) { return secret.required; });
            var set = required.filter(function (secret) { return secret.status === "set"; }).length;
            var pending = env.capabilities.filter(function (capability) { return !capability.healthy; }).map(function (capability) { return capability.id; });
            return h("tr", {}, h("td", { text: env.environment }), h("td", {}, chip(env.credentials.status)), h("td", { text: set + " / " + required.length }), h("td", { text: pending.length ? pending.join(", ") : "none" }));
          })))];
    } },
    { title: "Review & apply", render: function () {
      var items = diff ? diff.items : [];
      var approve = h("input", { type: "checkbox", id: "approve" });
      var applyButton = h("button", { class: "btn primary", text: "Apply approved plan", disabled: !diff || state.planOnly || dirty, onclick: function () {
        if (!approve.checked) { toast("Tick the approval box after reviewing every change", "warn"); return; }
        applyButton.disabled = true;
        api("POST", "/api/apply", { planHash: diff.planHash, approved: true, environment: credEnv }).then(function (result) { applyResult = result; toast("Applied; Doctor " + result.doctor.summary.failed + " failed"); diff = null; return refresh(); })
          .catch(function (error) { applyResult = { error: error.message, operations: (error.data && error.data.operations) || [] }; toast(error.message, "bad"); render(); });
      } });
      return [h("p", { class: "lead", text: "Save the SetupPlan, review the exact diff, approve it explicitly, then apply and verify with Doctor." }),
        state.savedPlanExists && !state.planSaved ? h("div", { class: "note warn", text: "A saved .trestle/setup.json exists. Saving replaces it; restart with --resume to continue editing the saved plan instead." }) : null,
        planIssues.length ? h("ul", { class: "issues" }, planIssues.map(function (issue) { return h("li", { text: (issue.path ? issue.path + ": " : "") + issue.message }); })) : null,
        h("div", { class: "row" }, h("button", { class: "btn", text: dirty ? "Save plan" : "Plan saved", disabled: !dirty && state.planSaved, onclick: savePlan }), h("button", { class: "btn", text: "Review diff", onclick: loadDiff })),
        diff ? [h("h3", { text: "Plan diff " + diff.planHash.slice(0, 12) }), h("table", {}, h("tbody", {}, items.map(function (item) { return h("tr", {}, h("td", {}, chip(item.classification.replace(" ", "-") === "already-correct" ? "ok" : item.classification, item.classification)), h("td", { class: "mono", text: item.id }), h("td", { text: item.summary })); }))),
          h("p", { text: diff.converged ? "Plan converged: nothing to change." : "Blocked items require source or provider work before apply can succeed." }),
          h("label", { class: "row" }, approve, h("span", { text: "I reviewed these exact changes and approve applying them." }))] : null,
        state.planOnly ? h("div", { class: "note warn", text: "Apply is disabled in --plan-only mode." }) : null,
        h("div", { class: "row" }, applyButton, h("span", { class: "muted", text: "Doctor runs for " + credEnv + " after apply." })),
        applyResult ? renderApply(applyResult) : null];
    } },
  ];

  function renderApply(result) {
    if (result.error) return h("div", {}, h("div", { class: "note bad", text: result.error }), result.operations.length ? h("table", {}, h("tbody", {}, result.operations.map(function (operation) { return h("tr", {}, h("td", {}, chip(operation.status)), h("td", { class: "mono", text: operation.id }), h("td", { text: operation.reason || "" })); }))) : null);
    var problems = result.doctor.checks.filter(function (check) { return check.status !== "pass"; });
    return h("div", {}, h("h3", { text: "Applied " + result.planHash.slice(0, 12) }),
      h("table", {}, h("tbody", {}, result.operations.map(function (operation) { return h("tr", {}, h("td", {}, chip(operation.status === "completed" ? "ok" : "fail", operation.status)), h("td", { class: "mono", text: operation.id }), h("td", { text: operation.files ? operation.files.length + " files" : "" })); }))),
      h("h3", { text: "Doctor: " + result.doctor.summary.passed + " passed, " + result.doctor.summary.warnings + " warnings, " + result.doctor.summary.failed + " failed" }),
      problems.length ? h("table", {}, h("tbody", {}, problems.map(function (check) { return h("tr", {}, h("td", {}, chip(check.status)), h("td", { text: check.message }), h("td", { class: "mono", text: check.remediation || "" })); }))) : h("p", { class: "muted", text: "All checks passed." }),
      h("p", { class: "muted", text: "Non-secret evidence recorded in " + result.evidence + "." }));
  }

  function savePlan() {
    planIssues = [];
    return api("PUT", "/api/plan", draft).then(function () { dirty = false; diff = null; toast("Saved .trestle/setup.json"); return refresh(); }).catch(function (error) {
      planIssues = (error.data && error.data.issues) || [{ message: error.message }];
      toast(error.message, "bad"); render();
    });
  }
  function loadDiff() {
    var ready = dirty ? savePlan() : Promise.resolve();
    return ready.then(function () { if (dirty) return; return api("GET", "/api/diff").then(function (result) { diff = result; render(); }); }).catch(function (error) { toast(error.message, "bad"); });
  }
  function refresh() {
    return api("GET", "/api/state").then(function (data) {
      state = data;
      if (!draft || !dirty) draft = JSON.parse(JSON.stringify(data.plan));
      if (!credEnv) credEnv = data.environment;
      render();
    });
  }

  function renderHeader() {
    var header = document.getElementById("header");
    if (!state) return;
    header.replaceChildren(
      h("div", {}, h("h1", { text: "Trestle setup · " + state.project.name }), h("div", { class: "meta", text: "TrestleJS " + state.project.trestleVersion + (state.planOnly ? " · plan-only" : "") + (dirty ? " · unsaved changes" : "") })),
      h("div", { class: "toolbar" },
        h("label", { class: "row" }, h("span", { class: "muted", text: "Credential environment" }), h("select", { onchange: function (event) { credEnv = event.target.value; render(); } }, state.environments.map(function (name) { var option = h("option", { value: name, text: name }); if (name === credEnv) option.selected = true; return option; }))),
        h("button", { class: "btn primary", text: dirty || !state.planSaved ? "Save plan" : "Saved", disabled: !dirty && state.planSaved, onclick: savePlan }),
        h("button", { class: "btn danger", text: "Close session", onclick: function () { api("POST", "/api/close", {}).finally(function () { root.replaceChildren(h("section", { class: "panel" }, h("h2", { text: "Setup session closed" }), h("p", { class: "lead", text: "You can close this tab. Run pnpm exec trestle setup --resume to continue later." }))); document.getElementById("header").replaceChildren(); }); } })));
  }

  function render() {
    renderHeader();
    var current = steps[step];
    var env = envState(credEnv);
    root.replaceChildren(
      h("nav", {}, h("ol", {}, steps.map(function (item, index) { return h("li", {}, h("button", { class: index === step ? "active" : "", onclick: function () { step = index; render(); } }, h("span", { class: "num", text: String(index + 1) }), item.title)); }))),
      h("section", { class: "panel" }, h("h2", { text: current.title }), current.render(),
        h("div", { class: "footer" }, h("button", { class: "btn", text: "Back", disabled: step === 0, onclick: function () { step -= 1; render(); } }), h("button", { class: "btn", text: "Next", disabled: step === steps.length - 1, onclick: function () { step += 1; render(); } }))),
      h("aside", { class: "status" },
        h("div", {}, h("h3", { text: "Capabilities · " + credEnv }), h("table", {}, h("tbody", {}, env.capabilities.map(function (capability) {
          return h("tr", { title: capability.missing.length ? "Missing: " + capability.missing.join(", ") : "" }, h("td", { text: capability.label }), h("td", {}, chip(capability.state)));
        }))), env.capabilities.some(function (capability) { return !capability.healthy; }) ? h("p", { class: "muted mono", text: env.capabilities.filter(function (capability) { return !capability.healthy; })[0].repair }) : null),
        h("div", {}, h("h3", { text: "Credentials · " + credEnv }), h("p", {}, chip(env.credentials.status), " ", h("span", { class: "muted", text: env.credentials.updatedAt ? "updated " + env.credentials.updatedAt : "" })),
          h("p", { class: "muted", text: env.secrets.filter(function (secret) { return secret.status === "set"; }).length + " of " + env.secrets.length + " declared secrets set. Values are never shown." }))));
  }

  refresh().catch(function (error) { toast(error.message, "bad"); });
})();
`;

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (character) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}

export function renderSetupPage(options: { nonce: string; csrf: string }): string {
  const nonce = escapeAttribute(options.nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="trestle-csrf" content="${escapeAttribute(options.csrf)}">
<title>Trestle setup</title>
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<header id="header"><h1>Trestle setup</h1></header>
<main class="layout" id="app"><section class="panel"><p class="lead">Loading project state…</p></section></main>
<div id="toast" aria-live="polite"></div>
<script nonce="${nonce}">${script}</script>
</body>
</html>
`;
}
