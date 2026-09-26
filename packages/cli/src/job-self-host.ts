import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Application-owned deployment scaffolds for self-hosted job runtimes. The
 * versions are pinned to the engines the conformance and crash-recovery
 * evidence in docs/JOB_RUNTIMES.md was gathered against.
 */
export const inngestImage = "inngest/inngest:v1.45.1";
export const triggerImageTag = "v4.6.4";

const exists = (file: string) => access(file).then(() => true, () => false);

async function writeNew(root: string, files: Record<string, string>): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const pending: Record<string, string> = {};
  for (const [relative, content] of Object.entries(files)) {
    if (!(await exists(path.join(root, relative)))) { pending[relative] = content; continue; }
    // A shared file already written by the other target is left alone when unchanged.
    if (await readFile(path.join(root, relative), "utf8") !== content) throw new Error(`${relative} already exists; move it aside first`);
  }
  files = pending;
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, { encoding: "utf8", flag: "wx" });
  }
  return Object.keys(files);
}

const inngestReadme = (project: string) => `# Self-hosted Inngest for ${project}

Inngest runs the Worker's functions by calling its signed endpoint,
\`/api/jobs/inngest\`. This directory runs the Inngest server itself.

## Requirements

- **PostgreSQL** (\`INNGEST_POSTGRES_URI\`, for example a Neon database separate
  from the application's) holds apps, functions, and history.
- **Redis** (\`INNGEST_REDIS_URI\`) is required, not optional. Without an
  external, persistent Redis, the server keeps queue and run state in memory.
  In TrestleJS's crash test (\`docker kill\` during a step), the in-flight run
  was lost without Redis and finished with it. Use a Redis with persistence
  (AOF), such as the one in \`docker-compose.yml\` or a managed Redis like
  Upstash.
- **Keys:** \`INNGEST_EVENT_KEY\` (any secret string) and
  \`INNGEST_SIGNING_KEY\` (hex, for example \`openssl rand -hex 32\`). The Worker
  uses the same values as its secrets.
- **Exactly one server:** the server is a singleton in this topology. Do not
  run replicas against one Redis.
- **TLS:** put the server behind HTTPS before exposing it. \`docker-compose.yml\`
  binds it to 127.0.0.1.

## Point the application at it

\`\`\`bash
pnpm exec trestle jobs use inngest --endpoint https://inngest.example.com --yes   # or edit jobs.endpoint
pnpm exec trestle secrets set INNGEST_EVENT_KEY --env production
pnpm exec trestle secrets set INNGEST_SIGNING_KEY --env production
\`\`\`

Then register \`https://<worker>/api/jobs/inngest\` as an app in the Inngest
dashboard (port 8288), or \`curl -X PUT https://<worker>/api/jobs/inngest\`.

## Operations

- **Upgrades:** change the pinned image in one place and re-run the TrestleJS
  conformance suite against it before deploying.
- **Backups:** back up the PostgreSQL database. Redis holds in-flight state:
  keep AOF on, and treat its loss as losing in-flight runs.
- **What recovers anyway:** TrestleJS settlement re-dispatches committed events
  that no consumer completed within 30 minutes, so even a lost run's event
  still runs once.
- **Missed schedules:** Inngest does not backfill crons while the server is
  down. TrestleJS's \`trestle-due-work\` cron computes due jobs from the
  database, so jobs that became due during an outage run on the next tick.
`;

const inngestCompose = `# Self-hosted Inngest: the server and a persistent Redis. PostgreSQL is external (INNGEST_POSTGRES_URI).
services:
  inngest:
    image: ${inngestImage}
    command: ["inngest", "start", "--port", "8288"]
    environment:
      INNGEST_EVENT_KEY: \${INNGEST_EVENT_KEY:?set INNGEST_EVENT_KEY}
      INNGEST_SIGNING_KEY: \${INNGEST_SIGNING_KEY:?set INNGEST_SIGNING_KEY (hex)}
      INNGEST_POSTGRES_URI: \${INNGEST_POSTGRES_URI:?set INNGEST_POSTGRES_URI}
      INNGEST_REDIS_URI: \${INNGEST_REDIS_URI:-redis://redis:6379}
    ports: ["127.0.0.1:8288:8288"]
    restart: unless-stopped
    depends_on: [redis]
  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["redis-data:/data"]
    restart: unless-stopped
volumes:
  redis-data: {}
`;

const containerWrangler = (project: string) => `{
  // Self-hosted Inngest on a Cloudflare Container: one always-warm server,
  // PostgreSQL on Neon and an external Redis. See ../README.md.
  "name": "${project}-inngest",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "containers": [{ "class_name": "InngestServer", "image": "../Dockerfile", "max_instances": 1 }],
  "durable_objects": { "bindings": [{ "name": "INNGEST_SERVER", "class_name": "InngestServer" }] },
  "migrations": [{ "tag": "inngest-server-v1", "new_sqlite_classes": ["InngestServer"] }],
  // Keeps the singleton warm, so Inngest's own crons and retries keep running.
  "triggers": { "crons": ["* * * * *"] },
  "secrets": { "required": ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "INNGEST_POSTGRES_URI", "INNGEST_REDIS_URI"] }
}
`;

const containerWorker = `import { Container, getContainer } from "@cloudflare/containers";

type Environment = {
  INNGEST_SERVER: DurableObjectNamespace<InngestServer>;
  INNGEST_EVENT_KEY: string;
  INNGEST_SIGNING_KEY: string;
  INNGEST_POSTGRES_URI: string;
  INNGEST_REDIS_URI: string;
};

/** The Inngest server as a single Cloudflare Container instance. */
export class InngestServer extends Container<Environment> {
  defaultPort = 8288;
  sleepAfter = "30m";
  constructor(context: DurableObjectState, environment: Environment) {
    super(context, environment);
    this.envVars = {
      INNGEST_EVENT_KEY: environment.INNGEST_EVENT_KEY,
      INNGEST_SIGNING_KEY: environment.INNGEST_SIGNING_KEY,
      INNGEST_POSTGRES_URI: environment.INNGEST_POSTGRES_URI,
      INNGEST_REDIS_URI: environment.INNGEST_REDIS_URI,
    };
  }
}

const server = (environment: Environment) => getContainer(environment.INNGEST_SERVER, "singleton");

export default {
  fetch: (request: Request, environment: Environment) => server(environment).fetch(request),
  // A health request every minute keeps the singleton running between events.
  scheduled: (_event: ScheduledController, environment: Environment, context: ExecutionContext) => {
    context.waitUntil(server(environment).fetch(new Request("http://inngest/health")));
  },
};
`;

const containerPackage = (project: string) => `${JSON.stringify({
  name: `${project}-inngest-server`,
  private: true,
  type: "module",
  scripts: { deploy: "wrangler deploy" },
  dependencies: { "@cloudflare/containers": "0.3.7" },
  devDependencies: { wrangler: "4.135.0" },
}, null, 2)}\n`;

export async function scaffoldSelfHostedInngest(root: string, project: string, target: "docker" | "cloudflare-container"): Promise<string[]> {
  const files: Record<string, string> = {
    "infra/inngest/README.md": inngestReadme(project),
    "infra/inngest/Dockerfile": `FROM ${inngestImage}\nCMD ["inngest", "start", "--port", "8288"]\n`,
  };
  if (target === "docker") files["infra/inngest/docker-compose.yml"] = inngestCompose;
  else Object.assign(files, {
    "infra/inngest/cloudflare/wrangler.jsonc": containerWrangler(project),
    "infra/inngest/cloudflare/src/index.ts": containerWorker,
    "infra/inngest/cloudflare/package.json": containerPackage(project),
  });
  return await writeNew(root, files);
}

export async function scaffoldSelfHostedTrigger(root: string, project: string): Promise<string[]> {
  return await writeNew(root, {
    "infra/trigger/README.md": `# Self-hosted trigger.dev for ${project}

TrestleJS's evidence for self-hosted trigger.dev covers the upstream Docker
setup at ${triggerImageTag}:

- the job runtime conformance suite passed against it;
- a run finished after its webapp and Redis were killed mid-run.

## Run it

\`\`\`bash
git clone --depth 1 https://github.com/triggerdotdev/trigger.dev
cd trigger.dev/hosting/docker
cp .env.example .env && ./generate-secrets.sh
# Pin the version TrestleJS tested; bind the webapp to localhost behind your TLS proxy.
printf 'TRIGGER_IMAGE_TAG=${triggerImageTag}\\nWEBAPP_PUBLISH_IP=127.0.0.1\\n' >> .env
docker compose -f webapp/docker-compose.yml -f worker/docker-compose.yml --env-file .env up -d
\`\`\`

The webapp needs about 3 vCPU and 6 GB of RAM. Each worker machine runs tasks
in containers through the supervisor and needs about 4 vCPU and 8 GB,
depending on concurrency. Worker machines are how tasks, including approved
Python scripts (\`apps/jobs/src/scripts.ts\`), run on your own servers.

## Point the application at it

\`\`\`bash
npx trigger.dev@4.6.4 login -a https://trigger.example.com --profile self-hosted
pnpm exec trestle jobs use trigger --project proj_… --endpoint https://trigger.example.com --yes
pnpm exec trestle secrets set TRIGGER_SECRET_KEY --env production
pnpm exec trestle jobs env push --env production --yes
pnpm --filter ./apps/jobs deploy -- --profile self-hosted
\`\`\`

Upgrade by changing TRIGGER_IMAGE_TAG together with the \`trigger.dev\`,
\`@trigger.dev/sdk\`, \`@trigger.dev/build\`, and \`@trigger.dev/python\` pins in
apps/jobs, then re-run the conformance suite. Back up the trigger.dev
PostgreSQL database.
`,
  });
}
