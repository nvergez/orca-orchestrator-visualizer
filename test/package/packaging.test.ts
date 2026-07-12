import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP } from '../../src/server/cli.ts';
import { MINIMUM_NODE } from '../../src/server/node-support.ts';
import { BUILT_FOR_SCHEMA_VERSION } from '../../src/server/schema.ts';

/**
 * The package is the deliverable of #22, so the package is the thing under test.
 *
 * `npx orca-viz` is the headline claim and the payoff from the `node:sqlite` decision: zero
 * native dependencies, nothing to compile on first run. That claim does not live in any
 * function — it lives in the manifest, and it dies quietly the day someone adds a dependency
 * that ships a binding.gyp. So it is asserted here, where it can be broken.
 *
 * The README is tested for the same reason: the promises it makes to a stranger about their
 * database are load-bearing, and the compatibility table is a *claim about the code* that
 * would otherwise rot silently the first time the schema floor moves.
 */

function repoFile(name: string): string {
  return fileURLToPath(new URL(`../../${name}`, import.meta.url));
}

const manifest = JSON.parse(readFileSync(repoFile('package.json'), 'utf8')) as {
  name: string;
  version: string;
  license: string;
  engines: Record<string, string>;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const readme = readFileSync(repoFile('README.md'), 'utf8');

describe('the npx claim: nothing to install, nothing to compile', () => {
  it('has no runtime dependencies of any kind — so there is no native build to fail', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });

  it('runs no install script — an npx user executes only what they asked for', () => {
    // `prepare` is npm's install-time hook too (it runs on `npm install <git-url>`), and
    // `prepublishOnly` is fine because it never runs on a consumer's machine.
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
      expect(manifest.scripts[hook], `package.json must not define a "${hook}" script`).toBeUndefined();
    }
  });

  it('ships the bin shim, the compiled server and the built frontend, and nothing else', () => {
    expect(manifest.files).toEqual(['bin', 'dist']);
    expect(manifest.bin).toEqual({ 'orca-viz': 'bin/orca-viz.mjs' });
    expect(existsSync(repoFile('bin/orca-viz.mjs'))).toBe(true);
  });

  it("the bin shim only reaches for files the package actually ships", () => {
    const shim = readFileSync(repoFile('bin/orca-viz.mjs'), 'utf8');
    const imports = [...shim.matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].map((match) => match[1] ?? match[2]);

    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      // Relative only — a bare specifier would be a runtime dependency by the back door, and
      // `../dist/...` is the only relative path that survives `files: ["bin", "dist"]`.
      expect(specifier, `bin/orca-viz.mjs imports "${specifier}"`).toMatch(/^\.\.\/dist\//);
    }
  });

  it('declares the same Node floor that the runtime check enforces', () => {
    // npm's `engines` warning is easy to miss, so node-support.ts checks at runtime too. The
    // two numbers must be one number.
    expect(manifest.engines.node).toBe(`>=${MINIMUM_NODE}`);
  });

  it('is unscoped orca-viz on independent 0.x semver, MIT, with the license text in the tree', () => {
    expect(manifest.name).toBe('orca-viz');
    expect(manifest.version).toMatch(/^0\./);
    expect(manifest.license).toBe('MIT');

    const license = readFileSync(repoFile('LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('WITHOUT WARRANTY OF ANY KIND');
  });
});

describe('the README, before a stranger points this at their machine', () => {
  /**
   * "Up front" is not a word count — it is a position: everything above the point where the
   * README starts telling you how to install and run the thing. A reader cannot reach the
   * instructions without having passed the disclosure.
   */
  const instructionsAt = readme.indexOf('## Requirements');
  const opening = readme.slice(0, instructionsAt);

  it('discloses before it instructs', () => {
    expect(instructionsAt, 'the README must have a ## Requirements section').toBeGreaterThan(0);
  });

  it('says unofficial, third-party, read-only and unaffiliated up front, not in a footnote', () => {
    for (const promise of [/unofficial/i, /third-party/i, /read-only/i, /not affiliated/i, /never writes/i]) {
      expect(opening, `the README must say ${promise} before it says how to install`).toMatch(promise);
    }
  });

  it('warns up front that the schema is internal and undocumented, so an update may need a bump', () => {
    expect(opening).toMatch(/internal/i);
    expect(opening).toMatch(/undocumented/i);
    expect(opening).toMatch(/bump/i);
  });

  it('records, in the compatibility table, the Orca schema version this build was verified against', () => {
    // The table is the documentation half of render-what-parses: the banner tells a user they
    // are past what we verified, and the table says what that verification was. Bump the
    // schema floor in code and this test makes you say so out loud.
    const table = readme.slice(readme.indexOf('## Compatibility'));
    const [major = '0', minor = '0'] = manifest.version.split('.');

    expect(table).toContain(`${major}.${minor}.x`);
    expect(table).toMatch(new RegExp(`\\|\\s*${BUILT_FOR_SCHEMA_VERSION}\\s*\\|`));
  });

  it('documents every flag the CLI actually accepts', () => {
    const flags = new Set([...HELP.matchAll(/^\s{2}(--[a-z-]+)/gm)].map((match) => match[1]));

    expect(flags.size).toBeGreaterThan(5);
    for (const flag of flags) {
      expect(readme, `the README must document ${flag}`).toContain(flag);
    }
  });
});
