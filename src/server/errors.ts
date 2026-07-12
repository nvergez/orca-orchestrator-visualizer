/**
 * The one error the boot path throws, and the one thing `main.ts` prints.
 *
 * Every startup failure this tool can hit — a `--db` that does not work, a database on a
 * network filesystem, a taken port, a `tasks` table with no `deps` — is a thing the user
 * can *do something about*. So they all carry a message written for the terminal, and none
 * of them reach the user as a stack trace.
 */
export class StartupError extends Error {
  override readonly name = 'StartupError';

  /** The line under the message: what to try next. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }

  /** How the user sees it. */
  override toString(): string {
    return this.hint === undefined ? this.message : `${this.message}\n  ${this.hint}`;
  }
}
