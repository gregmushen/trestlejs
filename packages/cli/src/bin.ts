#!/usr/bin/env node

import { executeCli } from "./cli.js";
import { processRuntime } from "./runtime.js";

process.exitCode = await executeCli(process.argv.slice(2), processRuntime);
