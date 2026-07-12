# Keep synthesized activity session-local

Transitions that Orca never records may be narrated only by diffing snapshots observed during the current browser session, from an explicit initial baseline and within a bounded in-memory list. The ticker never writes to SQLite, the server, browser storage, or a shadow event store, and it does not reconstruct transitions that occurred before the page opened. This trades replay for honesty: a short-lived supervision aid must not acquire the false authority of durable history.
