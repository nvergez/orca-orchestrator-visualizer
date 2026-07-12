/**
 * The `payload` column: TEXT holding JSON, with nothing anywhere enforcing that it is either.
 *
 * **Whatever does not parse is passed through as it was written.** A payload we cannot read is
 * still something a person can read, and the tool shows it (SPEC §5, render what parses). Every
 * reader below is a *shape check* rather than a cast, so a payload that came back as a raw
 * string simply answers "no" to each of them instead of throwing.
 *
 * One implementation, because two would drift — and the row that fell between them would be
 * exactly the malformed one this is careful about. Both server readers go through it: the message
 * log (`messages.ts`) and the gates (`gates.ts`), which reads the same column for the question.
 */
export function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * `payload.taskId` — the one field of an unvalidated JSON blob that the whole tool leans on.
 *
 * It carries **83% of message → run attribution** (SPEC §4.4) and it is the only thing that
 * links a message to a node. The column is TEXT with nothing enforcing what is in it, so
 * reading it is a shape check, not a cast.
 *
 * Shared, because both ends of the wire ask the same question of the same blob and would
 * answer it differently if they each wrote it out: the **server** asks it to decide which task
 * a message belongs to (`messages.ts`), and the **client** asks it to tell a message that never
 * named a task apart from one whose task an `orchestration reset` deleted — which is the
 * difference between an ordinary row and one the conversation has to mark "unlinked" (SPEC §4.2,
 * trap 8). Two implementations of that check would drift, and the row that fell between them
 * would be exactly the orphan the trap is about.
 */
export function taskIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const taskId = (payload as { taskId?: unknown }).taskId;
  return typeof taskId === 'string' && taskId !== '' ? taskId : null;
}
