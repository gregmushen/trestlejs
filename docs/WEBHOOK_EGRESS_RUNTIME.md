# Native webhook egress on Cloudflare Workers

Status: known issue; remote native delivery is deferred. Remote `WEBHOOK_DELIVERY_MODE` remains `disabled` by default.

## Deployed runtime evidence

On 2026-09-23, a disposable Worker using the generated native webhook transport was deployed to a Trestle-controlled Cloudflare account. It made a fixed, non-sensitive POST to `https://httpbin.org/post` from Cloudflare's runtime. DNS resolved eight public addresses, but the IP-pinned TLS connection failed with `proxy request failed, cannot connect to the specified address. It looks like you might be trying to connect to a HTTP-based service — consider using fetch instead`. The transport returned `{"kind":"failure","category":"network"}`. A separate direct TLS connection to the same approved address produced the same runtime error. The earlier version also used `ALPNProtocols`, which this runtime rejected with `ERR_OPTION_NOT_IMPLEMENTED`; that option has been removed, but doing so does not solve the port-443 connection restriction.

Cloudflare's [TCP socket troubleshooting documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#proxy-request-failed-cannot-connect-to-the-specified-address) directs HTTP requests on ports 80 and 443 to `fetch`. The generated native transport intentionally connects to a freshly approved IP address with the original hostname for TLS verification. Workers `fetch` does not provide this address-pinning contract for arbitrary destinations, so substituting it without an explicit security decision would change the outbound-webhook SSRF guarantee.

## Current safety contract

- Local capture, tenant isolation, signing, leases, retries, replay, and backpressure remain available for local and database-backed verification.
- `trestle doctor --env <remote>` fails when `WEBHOOK_DELIVERY_MODE=native`, even if its Queue and signing key are configured. Preview, staging, and production workflows run Doctor before deployment.
- Do not advertise native webhook delivery as production-ready. A beta candidate may proceed with the optional remote webhook capability disabled and this limitation disclosed; it must not claim deployed native delivery evidence.
- A supported remote transport needs a reviewed design and a successful deployed test against ordinary HTTPS destinations, including a destination behind Cloudflare. This design decision is intentionally deferred.

Possible paths are a trusted egress service that can pin approved IPs, or an explicit decision to accept Workers `fetch` with a reduced address-pinning guarantee. Either needs SSRF, redirect, DNS-rebinding, TLS, retry, observability, and failure-mode tests before enabling remote delivery.
