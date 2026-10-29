
## Per-tenant admin (kiyoh, klantenvertellen, kiyoh-cz)

Open `/admin.html?tenant=<id>` or use the tenant switcher (the coloured badge shows the active tenant). Every setting (packages/prices, modules, core features, currency + VAT, payment provider, SMTP, CRM webhook, Google Ads, notifications) is stored per tenant in `kiyoh_tenant_settings`; saving one tenant never changes another.

- **Betaalprovider**: choose the provider and (optionally) the *name* of the Railway env var holding the live/test key. Status shows whether a key is present and where it comes from; keys are never shown. Default order: chosen env var → `MOLLIE_<LIVE|TEST>_KEY_<TENANT>` → `MOLLIE_<LIVE|TEST>_KEY` → `MOLLIE_API_KEY` → admin-saved key.
- **Notificaties**: per event (order, signup, dealPaid, cancellation) recipients, on/off, webhook URL and secret (HMAC-SHA256 in `X-Kiyoh-Signature`), plus a BCC list and accountant address. Without settings the old behaviour applies; cancellation mails are off by default.
- **Versies & kopieren**: every save is a version; roll back to any version, or copy selected sections from another tenant. 2FA is global and never rolled back or copied.
- **Logs**: e-mails and webhooks for the selected tenant.
