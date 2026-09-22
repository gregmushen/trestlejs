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
trestle plan validate .trestle/setup.json
trestle plan diff .trestle/setup.json
trestle apply .trestle/setup.json --yes
trestle generate resource Article --tenant --crud
trestle resources --json
trestle routes --json
trestle doctor
```

See the [TrestleJS repository](https://github.com/gregmushen/trestlejs) for
documentation and source code.
