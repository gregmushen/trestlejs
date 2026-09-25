# trestlejs

The command-line interface for building and operating conventional TrestleJS
applications.

```bash
npm install --global trestlejs
trestle --help
```

To create a new application, use:

```bash
npx create-trestlejs my-app
```

Core architecture and setup commands include:

```bash
trestle plan init
trestle plan validate .trestle/setup.json
trestle plan diff .trestle/setup.json
trestle apply .trestle/setup.json --yes
trestle generate resource Article
trestle resources --json
trestle routes --json
trestle doctor
trestle email doctor --env staging
trestle --experimental payments stripe sync --env staging
trestle logs --env staging --status error
```

`trestle logs` displays a bounded projection of Trestle semantic events, not
raw Cloudflare requests, exception text, or arbitrary console output.

See the [TrestleJS repository](https://github.com/gregmushen/trestlejs) for
documentation and source code.
