import { boot } from './boot.ts';
import { StartupError } from './errors.ts';

/**
 * The process glue, and nothing else — everything worth testing lives in `boot()`.
 *
 * Its whole job is to turn a `StartupError` — a `--db` that does not work, a taken port, a
 * database with no task DAG in it — into a message a person can act on and a non-zero exit
 * code, rather than a stack trace.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await boot({ argv });
  } catch (error) {
    if (error instanceof StartupError) {
      console.error(`orca-viz: ${error.toString()}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
