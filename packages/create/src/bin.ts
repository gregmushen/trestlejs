#!/usr/bin/env node

import { executeCreateCli, processCreateRuntime } from "./cli.js";

process.exitCode = await executeCreateCli(process.argv.slice(2), processCreateRuntime);
