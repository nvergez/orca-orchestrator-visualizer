import { describe, expect, it } from 'vitest';
import { mergeReceipts, receiptOfResult, receiptOfWorkerDone } from '../../src/shared/receipt.ts';

/**
 * The outcome-receipt readers (#67, SPEC §12.4) — pure derivation over the two columns that
 * hold what a task produced: `tasks.result` and a `worker_done` message's `payload`.
 *
 * A pure suite is justified here for the same reason SPEC §12.5 names this exact surface:
 * a small algorithm with a dense error surface. The columns are TEXT with nothing anywhere
 * enforcing shape, so every reading is a shape check and never a cast — and the shapes
 * asserted below are the live database's own (worker payloads with `filesModified` and
 * `reportPath`; results carrying `completedBy`, `branch`, `ticket`/`pr` numbers), plus the
 * adversarial ones a reader that throws would die on.
 *
 * The rules under test, straight from the ticket:
 *
 * - **Never throw.** A payload that cannot be read answers with no facts, not an exception.
 * - **Additive.** Recognizing a field never consumes it — the raw value stays available and
 *   the caller renders it verbatim. Unknown fields simply produce no fact.
 * - **Provider-neutral.** A link is any valid `http:`/`https:` URL in any field; no provider
 *   name is ever consulted.
 * - **Provenance.** Every fact names the column and field it was read from, and merging two
 *   sources deduplicates values only by unioning that provenance — a conflict stays two facts.
 */

describe('receiptOfWorkerDone — the shapes real workers send', () => {
  it('reads produced files and the report path out of a live-shaped payload', () => {
    // Verbatim from the live database: every real worker_done payload has this shape.
    const facts = receiptOfWorkerDone({
      taskId: 'task_d37f35d1d159',
      dispatchId: 'ctx_4c065741dae2',
      filesModified: ['SPEC.md', 'CONTEXT.md', 'docs/adr/0001-one-shot-retained-run-archives.md'],
      reportPath: 'SPEC.md',
    });

    expect(facts).toEqual([
      { kind: 'report', value: 'SPEC.md', sources: ['worker_done.payload · reportPath'] },
      { kind: 'file', value: 'SPEC.md', sources: ['worker_done.payload · filesModified'] },
      { kind: 'file', value: 'CONTEXT.md', sources: ['worker_done.payload · filesModified'] },
      {
        kind: 'file',
        value: 'docs/adr/0001-one-shot-retained-run-archives.md',
        sources: ['worker_done.payload · filesModified'],
      },
    ]);
  });

  it('produces nothing from the bookkeeping fields every payload carries', () => {
    // `taskId` and `dispatchId` are routing, not outcomes — a receipt made of them would put
    // two ids on every single completed task's summary.
    expect(receiptOfWorkerDone({ taskId: 'task_x', dispatchId: 'ctx_y' })).toEqual([]);
  });

  it('keeps the string entries of a file list and skips the rest, rather than refusing the list', () => {
    const facts = receiptOfWorkerDone({ filesModified: ['a.ts', 42, null, {}, 'b.ts', ''] });

    expect(facts.map((fact) => fact.value)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('receiptOfResult — the shapes real coordinators write', () => {
  it('reads the completing agent out of the auto-complete shape', () => {
    // Orca's coordinator writes this shape itself: `{completedBy, filesModified, completedAt}`.
    const facts = receiptOfResult(
      '{"completedBy":"term_44902474-7a7a-4c0d-ab54-7c6c58be28ac","filesModified":[],"completedAt":"2026-07-08T12:38:17.798Z"}'
    );

    // The empty file list is no facts, and `completedAt` is a timestamp, not an outcome.
    expect(facts).toEqual([
      {
        kind: 'agent',
        value: 'term_44902474-7a7a-4c0d-ab54-7c6c58be28ac',
        sources: ['tasks.result · completedBy'],
      },
    ]);
  });

  it('reads a branch, and leaves what it does not recognize to the verbatim rendering', () => {
    const facts = receiptOfResult('{"branch":"nvergez/94-codex","head":"b41fb92"}');

    expect(facts).toEqual([{ kind: 'branch', value: 'nvergez/94-codex', sources: ['tasks.result · branch'] }]);
  });

  it('reads ticket identifiers whether they were written as numbers or strings', () => {
    // Live shape: `{"ticket":68,"pr":79,"note":"…"}` — a PR number is a ticket identifier
    // too, and the field name rides in the provenance so the reader can tell them apart.
    const facts = receiptOfResult('{"ticket":68,"pr":79,"note":"ticket #68 closed, PR #79 open"}');

    expect(facts).toEqual([
      { kind: 'ticket', value: '68', sources: ['tasks.result · ticket'] },
      { kind: 'ticket', value: '79', sources: ['tasks.result · pr'] },
    ]);
  });

  it('recognizes nothing in a prose result — prose is not scanned for facts', () => {
    expect(receiptOfResult('Done: three sentences about what happened.')).toEqual([]);
  });

  it('recognizes nothing in a result the task never had', () => {
    expect(receiptOfResult(null)).toEqual([]);
  });
});

describe('links — provider-neutral, validated, and never executable', () => {
  it('recognizes a valid http(s) URL in any field, whoever the provider is', () => {
    // The field names differ and the hosts differ; the facts are identical in kind. No
    // provider name is consulted anywhere (#67) — a self-hosted GitLab and a Jira cloud are
    // exactly as much an outcome as GitHub.
    const facts = receiptOfWorkerDone({
      prUrl: 'https://github.com/nvergez/orca-viz/pull/79',
      review: 'https://gitlab.example.com/team/repo/-/merge_requests/3',
      ticketUrl: 'http://jira.internal:8080/browse/ORCA-67',
    });

    expect(facts).toEqual([
      { kind: 'link', value: 'https://github.com/nvergez/orca-viz/pull/79', sources: ['worker_done.payload · prUrl'] },
      {
        kind: 'link',
        value: 'https://gitlab.example.com/team/repo/-/merge_requests/3',
        sources: ['worker_done.payload · review'],
      },
      {
        kind: 'link',
        value: 'http://jira.internal:8080/browse/ORCA-67',
        sources: ['worker_done.payload · ticketUrl'],
      },
    ]);
  });

  it('never linkifies what ordinary URL validation rejects, or a scheme that is not http(s)', () => {
    // `javascript:` is the one this rule exists for: a receipt is untrusted text out of a
    // database anyone can write to, and it must never become an href the browser executes.
    const facts = receiptOfResult(
      JSON.stringify({
        a: 'javascript:alert(1)',
        b: 'ftp://files.example.com/build.tar',
        c: 'not a url at all',
        d: '/relative/path/report.md',
        e: 'file:///etc/passwd',
      })
    );

    expect(facts).toEqual([]);
  });

  it('linkifies a URL sitting in a recognized path field, rather than calling it a path', () => {
    // "File and path facts are copyable text, not claims that the current machine can open
    // them" (SPEC §12.4) — and a URL is the reverse: a claim the *network* can open it. The
    // stronger recognition wins, once.
    const facts = receiptOfWorkerDone({ reportPath: 'https://ci.example.com/runs/42/report.html' });

    expect(facts).toEqual([
      {
        kind: 'link',
        value: 'https://ci.example.com/runs/42/report.html',
        sources: ['worker_done.payload · reportPath'],
      },
    ]);
  });
});

describe('never-throw — the adversarial shapes an unvalidated column can hold', () => {
  it('answers malformed JSON with no facts, never an exception', () => {
    expect(receiptOfResult('{"branch": "nvergez/94-codex"')).toEqual([]);
    expect(receiptOfResult('{{')).toEqual([]);
  });

  it('answers scalars, arrays and null payloads with no facts', () => {
    expect(receiptOfWorkerDone('a bare string')).toEqual([]);
    expect(receiptOfWorkerDone(42)).toEqual([]);
    expect(receiptOfWorkerDone(true)).toEqual([]);
    expect(receiptOfWorkerDone(null)).toEqual([]);
    expect(receiptOfWorkerDone(undefined)).toEqual([]);
    expect(receiptOfWorkerDone(['a.ts', 'b.ts'])).toEqual([]);
  });

  it('does not mine nested structure — a fact is a top-level field or it is nothing', () => {
    // Unknown objects render verbatim (#67); a reader that went digging through them would
    // be guessing at somebody else's schema.
    expect(receiptOfWorkerDone({ outcome: { branch: 'nvergez/94-codex' }, results: [{ pr: 79 }] })).toEqual([]);
  });

  it('recognizes no fact in a field of the wrong type, without losing the fields beside it', () => {
    const facts = receiptOfResult(JSON.stringify({ branch: 42, ticket: true, completedBy: 'worker-beta' }));

    expect(facts).toEqual([{ kind: 'agent', value: 'worker-beta', sources: ['tasks.result · completedBy'] }]);
  });

  it('survives hostile keys that JSON can smuggle into an object', () => {
    // `JSON.parse` creates an *own* property named `__proto__` — a reader that assigned
    // through it instead of reading entries would be poisoned. It is just a field here.
    expect(receiptOfResult('{"__proto__": {"branch": "evil"}, "constructor": "x"}')).toEqual([]);
    expect(receiptOfResult('{"__proto__": "https://example.com/x"}')).toEqual([
      { kind: 'link', value: 'https://example.com/x', sources: ['tasks.result · __proto__'] },
    ]);
  });

  it('trims whitespace and drops values that are nothing but it', () => {
    const facts = receiptOfResult(JSON.stringify({ branch: '  nvergez/96-claude  ', reportPath: '   ' }));

    expect(facts).toEqual([{ kind: 'branch', value: 'nvergez/96-claude', sources: ['tasks.result · branch'] }]);
  });
});

describe('mergeReceipts — deduplication that keeps its receipts', () => {
  it('shows a fact both sources stated once, wearing both provenances', () => {
    // The common case on a real database: the coordinator copies the worker's payload into
    // `tasks.result`, so the same file appears in both. One chip — but the reader can still
    // see that two independent columns agree, which is the only thing that makes the
    // deduplication honest (#67).
    const merged = mergeReceipts(
      receiptOfResult('{"filesModified":["src/a.ts"],"branch":"nvergez/67"}'),
      receiptOfWorkerDone({ filesModified: ['src/a.ts'] })
    );

    expect(merged).toEqual([
      { kind: 'branch', value: 'nvergez/67', sources: ['tasks.result · branch'] },
      {
        kind: 'file',
        value: 'src/a.ts',
        sources: ['tasks.result · filesModified', 'worker_done.payload · filesModified'],
      },
    ]);
  });

  it('keeps a conflict as two facts, both visible, each naming its side', () => {
    // The sources *disagree* — the worker said one branch and the result another. Collapsing
    // either would be inventing a certainty the file does not hold; both stay (#67).
    const merged = mergeReceipts(
      receiptOfResult('{"branch":"nvergez/94-codex"}'),
      receiptOfWorkerDone({ branch: 'nvergez/94-claude' })
    );

    expect(merged).toEqual([
      { kind: 'branch', value: 'nvergez/94-codex', sources: ['tasks.result · branch'] },
      { kind: 'branch', value: 'nvergez/94-claude', sources: ['worker_done.payload · branch'] },
    ]);
  });

  it('never lets one source mutate under the merge of another', () => {
    const result = receiptOfResult('{"branch":"nvergez/67"}');
    mergeReceipts(result, receiptOfWorkerDone({ branch: 'nvergez/67' }));

    // The input readings are evidence; a merge that grew their provenance in place would
    // change what a second consumer of the same reading sees.
    expect(result).toEqual([{ kind: 'branch', value: 'nvergez/67', sources: ['tasks.result · branch'] }]);
  });

  it('orders deterministically — kinds in display order, first appearance within a kind', () => {
    const merged = mergeReceipts(
      receiptOfWorkerDone({
        filesModified: ['z.ts', 'a.ts'],
        prUrl: 'https://example.com/pr/1',
        branch: 'nvergez/67',
        ticket: 68,
      })
    );

    expect(merged.map((fact) => `${fact.kind}:${fact.value}`)).toEqual([
      'link:https://example.com/pr/1',
      'branch:nvergez/67',
      'ticket:68',
      'file:z.ts',
      'file:a.ts',
    ]);
  });
});
