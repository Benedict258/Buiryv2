#!/usr/bin/env node
import { errorTag } from '@buiry/core';
import { main } from './main.js';

// A startup refusal (configuration, database, network mismatch) is printed as one clear message, not a stack trace.
main().catch((e: Error) => {
  // Buiry's own startup refusals are written for operators. Anything else (a database connection error names the
  // user, host and port) is reported by class and code only (sweep A13).
  console.error(
    e.message.startsWith('[buiry]') ? e.message : `[buiry] failed to start: ${JSON.stringify(errorTag(e))}`,
  );
  process.exit(1);
});
