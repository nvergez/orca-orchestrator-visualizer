import { readFileSync } from 'node:fs';

/**
 * The version npm published, read from the package's own manifest.
 *
 * `files: ["dist"]` still ships package.json, and `dist/server/` sits two levels under the
 * package root exactly as `src/server/` does — so one relative path works both compiled and
 * straight from source.
 *
 * Two callers, and they must agree: `--version` prints it, and every run archive records the
 * build that derived it (`provenance.tool`, #74). An archive that named a version the CLI does
 * not is an archive nobody can reproduce.
 */
export function toolVersion(): string {
  const manifest = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}
