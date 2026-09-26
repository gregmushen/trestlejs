# create-trestlejs

Create a new conventional TrestleJS application.

```bash
npx create-trestlejs my-app
```

The directory name becomes the project name, so it must use lowercase
letters, numbers and single hyphens. When the directory needs a different
name, such as a domain, pass the project name separately:

```bash
npx create-trestlejs freegardenplan.com --name freegardenplan
```

`--admin` includes the optional platform admin; `--no-install` and `--no-git`
skip dependency installation and git initialization.

The generated application includes the TrestleJS monorepo structure, local
development tooling, authentication, encrypted credentials, Cloudflare
deployment conventions, and the `trestle-setup` agent skill under
`.agents/skills/trestle-setup`.

See the [TrestleJS repository](https://github.com/gregmushen/trestlejs) for
documentation and source code.
