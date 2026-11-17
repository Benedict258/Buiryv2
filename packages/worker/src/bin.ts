#!/usr/bin/env node
import { main } from './main.js';

// A startup refusal (configuration, database, network mismatch) is printed as one clear message, not a stack trace.
main().catch((e: Error) => {
  console.error(e.message.startsWith('[buiry]') ? e.message : `[buiry] failed to start: ${e.message}`);
  process.exit(1);
});
