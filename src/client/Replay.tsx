import { Archive, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { Beams } from '@/components/fx/beams';
import { type ArchiveView, archiveHistory, archiveTaskLoader, fetchArchive, useArchive } from './archive.ts';
import { App } from './App.tsx';
import { enter, SPRING } from './motion.ts';
import { FIELD_BACKDROP_STYLE } from './surface.ts';

/**
 * **The archived replay** (#74, ADR 0001) — `orca-viz --archive <file>`, and the twin of
 * `Live.tsx` with everything live taken out of it.
 *
 * `Live` is an `EventSource` feeding `<App>`. This is **one fetch** feeding the same `<App>`: the
 * archive is read once, the loaders are pure functions over it (`archive.ts`), and there is no
 * timer, no cursor, no reconnect and no second read anywhere in the file. That is why the
 * "performs no polling, and claims no liveness" promise is not a promise — it is a shape. The
 * page that *could* poll is a different bundle (`main.tsx`), and the replay server does not serve
 * it (`server/server.ts`).
 *
 * Everything the reader then does — pick an agent, open a node, read the exchange, walk the deps —
 * is the ordinary selected-run presentation, unchanged, because a post-mortem you saved is still a
 * post-mortem. And nothing offers to write: this tool has never had a control that could, and an
 * archive has nothing to write *to*.
 */

export type ReplayProps = {
  /**
   * How the artifact is read — the real `GET /api/archive` by default, and a *value* for the same
   * reason `loadTask` and `loadHistory` are (`App.tsx`): the network lives at the edges, and a
   * test drives this page against a file rather than a fake server.
   */
  load?: () => Promise<ArchiveView>;
};

export function Replay({ load = fetchArchive }: ReplayProps = {}) {
  const { view, error } = useArchive(load);

  // Rebuilt only when the file is — which is once, on mount. Pure functions over one object.
  const loadHistory = useMemo(() => (view === null ? null : archiveHistory(view.archive)), [view]);
  const loadTask = useMemo(() => (view === null ? null : archiveTaskLoader(view.archive)), [view]);

  if (error !== null) return <BrokenArchive error={error} />;
  if (view === null || loadHistory === null || loadTask === null) return <OpeningArchive />;

  return <App event={null} archive={view} loadHistory={loadHistory} loadTask={loadTask} />;
}

/**
 * The archive would not open — and the whole screen is the message, because there is nothing else
 * on this page: no database to fall back to, no other run to show, and no live view to degrade to.
 *
 * The *actionable* version of this failure is the one in the terminal (`loadArchiveFile` refuses
 * before the server ever listens). This is what is left for a browser that reached a replay whose
 * file has gone wrong underneath it — a served archive that no longer parses, or a server that
 * could not read it back — and it says what happened rather than showing an empty canvas, which
 * would read as "this run had nothing in it".
 */
function BrokenArchive({ error }: { error: string }) {
  return (
    <main className="bg-field relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden px-6">
      <span aria-hidden className="pointer-events-none absolute inset-0" style={FIELD_BACKDROP_STYLE} />

      <motion.span
        initial={enter({ opacity: 0, scale: 0.8 })}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="text-destructive relative flex size-11 items-center justify-center rounded-2xl border"
      >
        <TriangleAlert className="size-5.5" />
      </motion.span>

      <h1 className="relative text-base font-semibold tracking-tight">This archive could not be read</h1>

      <p role="alert" className="text-muted-foreground relative max-w-prose text-center text-xs text-balance">
        {error}
      </p>
    </main>
  );
}

/** One blink, off a local file — but an empty canvas would mean "this run had no tasks". */
function OpeningArchive() {
  return (
    <main className="bg-field relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute inset-0" style={FIELD_BACKDROP_STYLE} />
      <Beams />

      <motion.span
        initial={enter({ opacity: 0, scale: 0.8 })}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="bg-muted text-muted-foreground relative flex size-11 items-center justify-center rounded-2xl"
      >
        <Archive className="size-5.5" />
      </motion.span>

      <motion.h1
        initial={enter({ opacity: 0, y: 6 })}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING, delay: 0.08 }}
        className="relative text-base font-semibold tracking-tight"
      >
        orca-viz
      </motion.h1>

      <motion.p
        initial={enter({ opacity: 0 })}
        animate={{ opacity: 1 }}
        transition={{ ...SPRING, delay: 0.16 }}
        className="text-muted-foreground relative text-xs"
      >
        Opening the archive…
      </motion.p>
    </main>
  );
}
