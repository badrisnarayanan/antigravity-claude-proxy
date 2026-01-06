#!/usr/bin/env node

import { run } from "../src/cli/index.js";

run().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
