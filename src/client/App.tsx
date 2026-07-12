import type { Meta, StreamEvent } from '../shared/types.ts';
import { livenessSentence } from '../shared/wording.ts';

/**
 * The shell the MVP panels get hung off — the run rail, gate strip, canvas, feed and
 * inspector arrive with their own tickets (#15–#20).
 *
 * What it renders *today* is `meta`: the truth about what the tool is looking at. That is
 * not a placeholder. A visualizer that cannot tell you whether it is showing a live
 * orchestration or last Tuesday's — or that it is reading a database you did not mean — is
 * worse than no visualizer, and no panel built on top of it would be worth anything.
 */
export function App({ event }: { event: StreamEvent | null }) {
  if (!event) {
    return (
      <main>
        <h1>orca-viz</h1>
        <p>Connecting to the database…</p>
      </main>
    );
  }

  return (
    <main>
      <h1>orca-viz</h1>
      <Status meta={event.meta} />
      <Notices meta={event.meta} />
      <Source meta={event.meta} />
    </main>
  );
}

/**
 * Live, or last-known — the one thing that is always worth saying, said in the words the
 * spec pins down (SPEC §6.1). `src/shared/wording.ts` owns the sentence, so this and the
 * line the terminal prints at boot are the same sentence and cannot drift apart.
 */
function Status({ meta }: { meta: Meta }) {
  return (
    <p role="status" data-state={meta.liveness}>
      {livenessSentence(meta, formatTime)}.
    </p>
  );
}

/**
 * The things that are *wrong*, in the order they change what you should believe about the
 * screen. Nothing renders when there is nothing to say: a banner that is always there is
 * furniture, and furniture stops being read.
 */
function Notices({ meta }: { meta: Meta }) {
  return (
    <>
      {meta.schemaSupport === 'newer' && (
        <p role="status" data-state="schema-newer">
          This database is from a newer Orca schema (v{meta.schemaVersion}) — some data may be missing or mislabeled.
        </p>
      )}

      {meta.resetDetected && (
        <p role="status" data-state="reset">
          Some history is gone: an <code>orchestration reset</code> wiped messages this database once held.
        </p>
      )}

      {meta.degraded.length > 0 && (
        <section data-state="degraded">
          <h2>Reduced by an older Orca (schema v{meta.schemaVersion})</h2>
          <ul>
            {meta.degraded.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Always on screen, always true: the file, and the schema it turned out to be. */
function Source({ meta }: { meta: Meta }) {
  return (
    <dl>
      <dt>Database</dt>
      <dd>
        <code>{meta.dbPath}</code>
      </dd>

      <dt>Schema</dt>
      <dd>v{meta.schemaVersion}</dd>

      <dt>Last write</dt>
      <dd>{formatTime(meta.dbMtime)}</dd>
    </dl>
  );
}

/** An instant a person can place, in their own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
