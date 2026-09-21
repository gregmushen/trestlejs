# TrestleJS

TrestleJS is an opinionated, Rails-inspired TypeScript application stack for
durable, multi-tenant applications on Cloudflare.

This repository contains the TrestleJS toolchain itself:

- `@trestlejs/core`: versioned project metadata and shared deterministic logic;
- `trestlejs`: the `trestle` executable;
- `create-trestlejs`: the `create-trestlejs` project bootstrapper; and
- the canonical generated application template.

The architecture contract is [docs/TRESTLEJS_SPEC.md](docs/TRESTLEJS_SPEC.md).

## Development

```bash
pnpm install
pnpm check
pnpm build
```

The target public packages are `trestlejs` and `create-trestlejs`. The CLI
binary is the shorter `trestle`; internal shared packages use the `@trestlejs`
scope.

## Try the prerelease

```bash
npx create-trestlejs@next my-app
```

Release maintainers should follow [the publishing guide](docs/PUBLISHING.md).
