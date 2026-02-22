import * as assert from 'assert';
import { AnchorEngine } from '../../anchorEngine';
import type { CommentThread, MarkdownSection, CommentAnchor } from '../../models/types';
import { computeContentHash } from '../../utils/hash';

/** Helper: build a MarkdownSection */
function section(overrides: Partial<MarkdownSection> = {}): MarkdownSection {
  const heading = overrides.heading ?? 'Introduction';
  const content = overrides.content ?? 'Some intro content.';
  return {
    heading,
    slug: overrides.slug ?? 'introduction',
    level: overrides.level ?? 1,
    startLine: overrides.startLine ?? 0,
    endLine: overrides.endLine ?? 5,
    content,
    contentHash: overrides.contentHash ?? computeContentHash(content),
  };
}

/** Helper: build a CommentThread (domain type, not vscode.CommentThread) */
function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: overrides.id ?? 'thread-1',
    anchor: overrides.anchor ?? {
      sectionSlug: 'introduction',
      contentHash: computeContentHash('Some intro content.'),
      lineHint: 0,
    },
    status: overrides.status ?? 'open',
    isDraft: overrides.isDraft ?? false,
    thread: overrides.thread ?? [
      {
        id: 'entry-1',
        author: 'alice',
        body: 'Looks good',
        created: new Date().toISOString(),
        edited: null,
      },
    ],
  };
}

suite('AnchorEngine Test Suite', () => {
  // ── createAnchor ─────────────────────────────────────────────────

  test('createAnchor returns correct anchor from a section', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const anchor = engine.createAnchor(sec);

    assert.strictEqual(anchor.sectionSlug, 'introduction');
    assert.strictEqual(anchor.contentHash, sec.contentHash);
    assert.strictEqual(anchor.lineHint, sec.startLine);
  });

  test('createAnchor preserves different slugs and lines', () => {
    const engine = new AnchorEngine();
    const sec = section({
      heading: 'API Endpoints',
      slug: 'api-endpoints',
      startLine: 42,
      content: 'GET /users returns all users.',
    });
    const anchor = engine.createAnchor(sec);

    assert.strictEqual(anchor.sectionSlug, 'api-endpoints');
    assert.strictEqual(anchor.lineHint, 42);
    assert.strictEqual(anchor.contentHash, computeContentHash('GET /users returns all users.'));
  });

  // ── findAnchoredSection ──────────────────────────────────────────

  test('findAnchoredSection returns matching section with isStale=false', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const anchor: CommentAnchor = {
      sectionSlug: 'introduction',
      contentHash: sec.contentHash,
      lineHint: 0,
    };

    const result = engine.findAnchoredSection([sec], anchor);
    assert.ok(result);
    assert.strictEqual(result!.section.heading, 'Introduction');
    assert.strictEqual(result!.isStale, false);
  });

  test('findAnchoredSection returns isStale=true when hash differs', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const anchor: CommentAnchor = {
      sectionSlug: 'introduction',
      contentHash: 'old-hash-value',
      lineHint: 0,
    };

    const result = engine.findAnchoredSection([sec], anchor);
    assert.ok(result);
    assert.strictEqual(result!.isStale, true);
  });

  test('findAnchoredSection returns null when slug not found', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const anchor: CommentAnchor = {
      sectionSlug: 'nonexistent-section',
      contentHash: 'anything',
      lineHint: 0,
    };

    const result = engine.findAnchoredSection([sec], anchor);
    assert.strictEqual(result, null);
  });

  test('findAnchoredSection picks correct section from multiple', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', content: 'Intro content' }),
      section({ heading: 'API', slug: 'api', content: 'API content', startLine: 10 }),
      section({ heading: 'Auth', slug: 'auth', content: 'Auth content', startLine: 20 }),
    ];
    const anchor: CommentAnchor = {
      sectionSlug: 'api',
      contentHash: computeContentHash('API content'),
      lineHint: 10,
    };

    const result = engine.findAnchoredSection(sections, anchor);
    assert.ok(result);
    assert.strictEqual(result!.section.heading, 'API');
    assert.strictEqual(result!.isStale, false);
  });

  // ── detectStaleThreads ───────────────────────────────────────────

  test('detectStaleThreads returns empty when all threads match', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const t = thread({ anchor: { sectionSlug: 'introduction', contentHash: sec.contentHash, lineHint: 0 } });

    const updates = engine.detectStaleThreads([sec], [t]);
    assert.strictEqual(updates.length, 0);
  });

  test('detectStaleThreads marks thread stale when content drifted', () => {
    const engine = new AnchorEngine();
    const sec = section(); // current content hash
    const t = thread({
      status: 'open',
      anchor: { sectionSlug: 'introduction', contentHash: 'old-hash', lineHint: 0 },
    });

    const updates = engine.detectStaleThreads([sec], [t]);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].newStatus, 'stale');
    assert.strictEqual(updates[0].thread.id, t.id);
  });

  test('detectStaleThreads marks thread stale when section is missing', () => {
    const engine = new AnchorEngine();
    const t = thread({
      status: 'open',
      anchor: { sectionSlug: 'deleted-section', contentHash: 'any', lineHint: 0 },
    });

    const updates = engine.detectStaleThreads([], [t]); // no sections at all
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].newStatus, 'stale');
  });

  test('detectStaleThreads reverts stale to open when content matches again', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const t = thread({
      status: 'stale',
      anchor: { sectionSlug: 'introduction', contentHash: sec.contentHash, lineHint: 0 },
    });

    const updates = engine.detectStaleThreads([sec], [t]);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].newStatus, 'open');
  });

  test('detectStaleThreads skips resolved threads', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const t = thread({
      status: 'resolved',
      anchor: { sectionSlug: 'introduction', contentHash: 'wrong-hash', lineHint: 0 },
    });

    const updates = engine.detectStaleThreads([sec], [t]);
    assert.strictEqual(updates.length, 0); // resolved threads are never changed
  });

  test('detectStaleThreads does not re-report already stale threads', () => {
    const engine = new AnchorEngine();
    const sec = section();
    const t = thread({
      status: 'stale',
      anchor: { sectionSlug: 'introduction', contentHash: 'different-hash', lineHint: 0 },
    });

    const updates = engine.detectStaleThreads([sec], [t]);
    assert.strictEqual(updates.length, 0); // already stale, no change needed
  });

  test('detectStaleThreads handles multiple threads with mixed states', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'A', slug: 'a', content: 'Content A' }),
      section({ heading: 'B', slug: 'b', content: 'Content B' }),
    ];

    const threads = [
      // open, matching → no update
      thread({
        id: 't1',
        status: 'open',
        anchor: { sectionSlug: 'a', contentHash: computeContentHash('Content A'), lineHint: 0 },
      }),
      // open, drifted → stale
      thread({
        id: 't2',
        status: 'open',
        anchor: { sectionSlug: 'b', contentHash: 'old', lineHint: 5 },
      }),
      // resolved, drifted → skip
      thread({
        id: 't3',
        status: 'resolved',
        anchor: { sectionSlug: 'a', contentHash: 'old', lineHint: 0 },
      }),
      // stale, now matching → open
      thread({
        id: 't4',
        status: 'stale',
        anchor: { sectionSlug: 'a', contentHash: computeContentHash('Content A'), lineHint: 0 },
      }),
    ];

    const updates = engine.detectStaleThreads(sections, threads);
    assert.strictEqual(updates.length, 2);

    const t2Update = updates.find(u => u.thread.id === 't2');
    assert.ok(t2Update);
    assert.strictEqual(t2Update!.newStatus, 'stale');

    const t4Update = updates.find(u => u.thread.id === 't4');
    assert.ok(t4Update);
    assert.strictEqual(t4Update!.newStatus, 'open');
  });

  // ── Cache behaviour (clearCache) ─────────────────────────────────

  test('clearCache removes stored sections', () => {
    const engine = new AnchorEngine();
    engine.clearCache('file:///test.md');
    // No assertion needed — just verifying no error is thrown
  });

  // ── findSectionByLine ────────────────────────────────────────────

  test('findSectionByLine returns section containing the line', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'A', slug: 'a', startLine: 0, endLine: 5 }),
      section({ heading: 'B', slug: 'b', startLine: 5, endLine: 12 }),
      section({ heading: 'C', slug: 'c', startLine: 12, endLine: 20 }),
    ];

    assert.strictEqual(engine.findSectionByLine(sections, 0)?.heading, 'A');
    assert.strictEqual(engine.findSectionByLine(sections, 3)?.heading, 'A');
    assert.strictEqual(engine.findSectionByLine(sections, 5)?.heading, 'B');
    assert.strictEqual(engine.findSectionByLine(sections, 11)?.heading, 'B');
    assert.strictEqual(engine.findSectionByLine(sections, 12)?.heading, 'C');
    assert.strictEqual(engine.findSectionByLine(sections, 19)?.heading, 'C');
  });

  test('findSectionByLine returns undefined for out-of-range line', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'A', slug: 'a', startLine: 0, endLine: 5 }),
    ];

    assert.strictEqual(engine.findSectionByLine(sections, 5), undefined); // endLine is exclusive
    assert.strictEqual(engine.findSectionByLine(sections, 99), undefined);
  });

  test('findSectionByLine returns undefined for empty sections', () => {
    const engine = new AnchorEngine();
    assert.strictEqual(engine.findSectionByLine([], 0), undefined);
  });

  // ── Orphaned thread identification ───────────────────────────────

  test('findAnchoredSection returns null for orphaned thread (section deleted)', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', content: 'Intro content' }),
      section({ heading: 'Setup', slug: 'setup', content: 'Setup content' }),
    ];
    
    // Anchor points to a section that no longer exists
    const orphanedAnchor: CommentAnchor = {
      sectionSlug: 'deleted-authentication-section',
      contentHash: 'some-old-hash',
      lineHint: 50,
    };

    const result = engine.findAnchoredSection(sections, orphanedAnchor);
    assert.strictEqual(result, null, 'Orphaned anchor should return null');
  });

  test('detectStaleThreads identifies orphaned threads by missing slug', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', content: 'Intro content' }),
    ];

    // Thread 1: anchored to existing section → no update
    const validThread = thread({
      id: 'valid',
      status: 'open',
      anchor: { sectionSlug: 'intro', contentHash: computeContentHash('Intro content'), lineHint: 0 },
    });

    // Thread 2: anchored to section that was deleted → becomes stale (orphaned)
    const orphanedThread = thread({
      id: 'orphaned',
      status: 'open',
      anchor: { sectionSlug: 'deleted-section', contentHash: 'any', lineHint: 99 },
    });

    const updates = engine.detectStaleThreads(sections, [validThread, orphanedThread]);
    
    assert.strictEqual(updates.length, 1, 'Only orphaned thread should need update');
    assert.strictEqual(updates[0].thread.id, 'orphaned');
    assert.strictEqual(updates[0].newStatus, 'stale', 'Orphaned thread should become stale');
  });

  test('orphaned thread with stale status remains unchanged', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', content: 'Intro content' }),
    ];

    // Already stale thread with missing section should not generate another update
    const alreadyStaleOrphan = thread({
      id: 'stale-orphan',
      status: 'stale',
      anchor: { sectionSlug: 'long-gone-section', contentHash: 'any', lineHint: 0 },
    });

    const updates = engine.detectStaleThreads(sections, [alreadyStaleOrphan]);
    assert.strictEqual(updates.length, 0, 'Already stale orphaned thread should not update');
  });

  // ── findReparentCandidate ────────────────────────────────────────

  test('findReparentCandidate returns section matching lineHint', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', startLine: 0, content: 'Intro content' }),
      section({ heading: 'New Auth Section', slug: 'new-auth-section', startLine: 10, content: 'Auth content' }),
      section({ heading: 'Conclusion', slug: 'conclusion', startLine: 20, content: 'Conclusion content' }),
    ];

    // Anchor with lineHint=10 should match the section at line 10
    const anchor: CommentAnchor = {
      sectionSlug: 'old-authentication', // old slug that no longer exists
      contentHash: 'old-hash',
      lineHint: 10,
    };

    const candidate = engine.findReparentCandidate(sections, anchor);
    assert.ok(candidate, 'Should find a reparent candidate');
    assert.strictEqual(candidate!.slug, 'new-auth-section');
    assert.strictEqual(candidate!.heading, 'New Auth Section');
  });

  test('findReparentCandidate returns section matching contentHash when lineHint does not match', () => {
    const engine = new AnchorEngine();
    const content = 'This is the original content that was not changed.';
    const sections = [
      section({ heading: 'Intro', slug: 'intro', startLine: 0, content: 'Intro content' }),
      section({ heading: 'Renamed Section', slug: 'renamed-section', startLine: 15, content }),
    ];

    // Anchor with matching contentHash but different lineHint
    const anchor: CommentAnchor = {
      sectionSlug: 'original-section',
      contentHash: computeContentHash(content),
      lineHint: 99, // wrong line
    };

    const candidate = engine.findReparentCandidate(sections, anchor);
    assert.ok(candidate, 'Should find a reparent candidate by content hash');
    assert.strictEqual(candidate!.slug, 'renamed-section');
  });

  test('findReparentCandidate returns null when no match found', () => {
    const engine = new AnchorEngine();
    const sections = [
      section({ heading: 'Intro', slug: 'intro', startLine: 0, content: 'Intro content' }),
      section({ heading: 'Setup', slug: 'setup', startLine: 5, content: 'Setup content' }),
    ];

    const anchor: CommentAnchor = {
      sectionSlug: 'deleted-section',
      contentHash: 'unique-hash-not-matching-anything',
      lineHint: 999, // no section at this line
    };

    const candidate = engine.findReparentCandidate(sections, anchor);
    assert.strictEqual(candidate, null, 'Should return null when no candidate found');
  });

  test('findReparentCandidate prioritizes lineHint over contentHash', () => {
    const engine = new AnchorEngine();
    const content = 'Shared content between sections.';
    const sections = [
      section({ heading: 'Section A', slug: 'section-a', startLine: 5, content }),
      section({ heading: 'Section B', slug: 'section-b', startLine: 10, content }),
    ];

    // Both sections have the same content, but lineHint matches Section A
    const anchor: CommentAnchor = {
      sectionSlug: 'old-section',
      contentHash: computeContentHash(content),
      lineHint: 5,
    };

    const candidate = engine.findReparentCandidate(sections, anchor);
    assert.ok(candidate);
    assert.strictEqual(candidate!.slug, 'section-a', 'Should prioritize lineHint match');
  });
});
