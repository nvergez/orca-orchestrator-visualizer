import { createServer, DEFAULT_HOST, DEFAULT_PORT } from './server.ts';

// Loopback only (SPEC §1.2): the database holds task specs, agent prompts and message
// bodies. Flags, database discovery and the browser auto-open land in #14.
createServer().listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(`orca-viz listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
});
