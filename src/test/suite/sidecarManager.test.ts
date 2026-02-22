import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidecarManager } from '../../sidecarManager';
import type { SidecarFile, CommentThread } from '../../models/types';

/**
 * Helper: create a fresh SidecarManager instance for test isolation.
 * (The singleton export is for production; tests use their own instance.)
 */
function makeSidecar(): SidecarManager {
  return new SidecarManager();
}

/** Helper: build a minimal valid SidecarFile */
function emptySidecar(doc = 'test.md'): SidecarFile {
  return { doc, version: '1.0', comments: [] };
}

/** Helper: build a thread stub (Omit<CommentThread, 'id'>) */
function threadStub(overrides: Partial<Omit<CommentThread, 'id'>> = {}): Omit<CommentThread, 'id'> {
  return {
    anchor: {
      sectionSlug: 'introduction',
      contentHash: 'abc123',
      lineHint: 0,
    },
    status: 'open',
    isDraft: true,
    thread: [
      {
        id: 'entry-1',
        author: 'alice',
        body: 'Looks good!',
        created: new Date().toISOString(),
        edited: null,
      },
    ],
    ...overrides,
  };
}

suite('SidecarManager Test Suite', () => {
  // ── Path helpers ──────────────────────────────────────────────────

  test('getSidecarPath returns .comments.json sibling', () => {
    const mgr = makeSidecar();
    const result = mgr.getSidecarPath('/repo/design/doc.md');
    assert.strictEqual(result, path.join('/repo/design', 'doc.comments.json'));
  });

  test('getSidecarPath strips only .md extension', () => {
    const mgr = makeSidecar();
    const result = mgr.getSidecarPath('/repo/notes.md');
    assert.strictEqual(result, path.join('/repo', 'notes.comments.json'));
  });

  test('getSidecarPath handles nested directories', () => {
    const mgr = makeSidecar();
    const result = mgr.getSidecarPath('/a/b/c/deep.md');
    assert.strictEqual(result, path.join('/a/b/c', 'deep.comments.json'));
  });

  // ── createEmptySidecar ────────────────────────────────────────────

  test('createEmptySidecar returns valid structure', () => {
    const mgr = makeSidecar();
    const sc = mgr.createEmptySidecar('design.md');
    assert.strictEqual(sc.doc, 'design.md');
    assert.strictEqual(sc.version, '1.0');
    assert.ok(Array.isArray(sc.comments));
    assert.strictEqual(sc.comments.length, 0);
  });

  // ── addThread ────────────────────────────────────────────────────

  test('addThread assigns a UUID and appends to comments', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const added = mgr.addThread(sc, threadStub());

    assert.strictEqual(sc.comments.length, 1);
    assert.ok(added.id, 'thread must receive an id');
    assert.strictEqual(added.anchor.sectionSlug, 'introduction');
    assert.strictEqual(added.status, 'open');
    assert.strictEqual(added.thread.length, 1);
  });

  test('addThread generates unique IDs for multiple threads', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const t1 = mgr.addThread(sc, threadStub());
    const t2 = mgr.addThread(sc, threadStub({ anchor: { sectionSlug: 'api', contentHash: 'xyz', lineHint: 10 } }));

    assert.strictEqual(sc.comments.length, 2);
    assert.notStrictEqual(t1.id, t2.id);
  });

  // ── addReply ─────────────────────────────────────────────────────

  test('addReply appends an entry with a new UUID', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    const reply = mgr.addReply(sc, thread.id, {
      author: 'bob',
      body: 'I agree.',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.ok(reply);
    assert.ok(reply!.id);
    assert.strictEqual(reply!.author, 'bob');
    assert.strictEqual(thread.thread.length, 2); // original + reply
  });

  test('addReply returns null for unknown threadId', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    const reply = mgr.addReply(sc, 'nonexistent-id', {
      author: 'bob',
      body: 'Hi',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.strictEqual(reply, null);
  });

  // ── deleteThread ─────────────────────────────────────────────────

  test('deleteThread removes the thread', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    const deleted = mgr.deleteThread(sc, thread.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(sc.comments.length, 0);
  });

  test('deleteThread returns false for unknown id', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    assert.strictEqual(mgr.deleteThread(sc, 'no-such-id'), false);
  });

  // ── deleteComment (by index) ─────────────────────────────────────

  test('deleteComment removes a comment by index', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    // Add a second comment so deletion doesn't remove thread
    mgr.addReply(sc, thread.id, {
      author: 'bob',
      body: 'Reply',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.strictEqual(thread.thread.length, 2);
    const deleted = mgr.deleteComment(sc, thread.id, 0);
    assert.strictEqual(deleted, true);
    assert.strictEqual(thread.thread.length, 1);
    assert.strictEqual(thread.thread[0].author, 'bob');
  });

  test('deleteComment removes entire thread when last comment is deleted', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    assert.strictEqual(sc.comments.length, 1);
    const deleted = mgr.deleteComment(sc, thread.id, 0);
    assert.strictEqual(deleted, true);
    assert.strictEqual(sc.comments.length, 0);
  });

  test('deleteComment returns false for out-of-range index', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    assert.strictEqual(mgr.deleteComment(sc, thread.id, -1), false);
    assert.strictEqual(mgr.deleteComment(sc, thread.id, 99), false);
  });

  test('deleteComment returns false for unknown thread', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    assert.strictEqual(mgr.deleteComment(sc, 'no-such-id', 0), false);
  });

  // ── deleteCommentById ────────────────────────────────────────────

  test('deleteCommentById removes the correct entry', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    const reply = mgr.addReply(sc, thread.id, {
      author: 'bob',
      body: 'Reply',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.strictEqual(thread.thread.length, 2);
    const deleted = mgr.deleteCommentById(sc, thread.id, reply!.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(thread.thread.length, 1);
    assert.strictEqual(thread.thread[0].id, 'entry-1'); // original remains
  });

  test('deleteCommentById returns false for unknown comment id', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    assert.strictEqual(mgr.deleteCommentById(sc, thread.id, 'no-such-comment'), false);
  });

  test('deleteCommentById returns false for unknown thread id', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    assert.strictEqual(mgr.deleteCommentById(sc, 'no-such-thread', 'any'), false);
  });

  // ── editComment ──────────────────────────────────────────────────

  test('editComment updates body and sets edited timestamp', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    const original = thread.thread[0];
    assert.strictEqual(original.edited, null);

    const updated = mgr.editComment(sc, thread.id, original.id, 'Updated body');
    assert.ok(updated);
    assert.strictEqual(updated!.body, 'Updated body');
    assert.ok(updated!.edited, 'edited should be set');
  });

  test('editComment returns null for unknown thread', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    assert.strictEqual(mgr.editComment(sc, 'no-thread', 'no-comment', 'x'), null);
  });

  test('editComment returns null for unknown comment', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    assert.strictEqual(mgr.editComment(sc, thread.id, 'no-comment', 'x'), null);
  });

  // ── updateThreadStatus ───────────────────────────────────────────

  test('updateThreadStatus changes status', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub());

    assert.strictEqual(thread.status, 'open');
    const ok = mgr.updateThreadStatus(sc, thread.id, 'resolved');
    assert.strictEqual(ok, true);
    assert.strictEqual(thread.status, 'resolved');
  });

  test('updateThreadStatus returns false for unknown id', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();

    assert.strictEqual(mgr.updateThreadStatus(sc, 'no-thread', 'resolved'), false);
  });

  // ── getDraftThreads ──────────────────────────────────────────────

  test('getDraftThreads filters only drafts', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    mgr.addThread(sc, threadStub({ isDraft: true }));
    mgr.addThread(sc, threadStub({ isDraft: false }));
    mgr.addThread(sc, threadStub({ isDraft: true }));

    const drafts = mgr.getDraftThreads(sc);
    assert.strictEqual(drafts.length, 2);
    assert.ok(drafts.every(t => t.isDraft));
  });

  test('getDraftThreads returns empty array when no drafts', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    mgr.addThread(sc, threadStub({ isDraft: false }));

    assert.strictEqual(mgr.getDraftThreads(sc).length, 0);
  });

  // ── markAllPublished ─────────────────────────────────────────────

  test('markAllPublished sets isDraft to false on all threads', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    mgr.addThread(sc, threadStub({ isDraft: true }));
    mgr.addThread(sc, threadStub({ isDraft: true }));

    mgr.markAllPublished(sc);
    assert.ok(sc.comments.every(t => t.isDraft === false));
  });

  // ── reparentThread ──────────────────────────────────────────────

  test('reparentThread updates anchor and resets status', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const thread = mgr.addThread(sc, threadStub({
      anchor: { sectionSlug: 'old-section', contentHash: 'old-hash', lineHint: 5 },
      status: 'stale',
      isDraft: false,
    }));

    const newAnchor = { sectionSlug: 'new-section', contentHash: 'new-hash', lineHint: 10 };
    const result = mgr.reparentThread(sc, thread.id, newAnchor);

    assert.strictEqual(result, true);
    assert.strictEqual(sc.comments[0].anchor.sectionSlug, 'new-section');
    assert.strictEqual(sc.comments[0].anchor.contentHash, 'new-hash');
    assert.strictEqual(sc.comments[0].anchor.lineHint, 10);
    assert.strictEqual(sc.comments[0].status, 'open', 'Status should be reset to open');
    assert.strictEqual(sc.comments[0].isDraft, true, 'Thread should be marked as draft');
  });

  test('reparentThread returns false for unknown thread', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    mgr.addThread(sc, threadStub());

    const newAnchor = { sectionSlug: 'new-section', contentHash: 'new-hash', lineHint: 10 };
    const result = mgr.reparentThread(sc, 'nonexistent-id', newAnchor);

    assert.strictEqual(result, false);
  });

  // ── File I/O round-trip ──────────────────────────────────────────

  test('writeSidecar and readSidecar round-trip correctly', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'design.md');

    // Create a dummy md file so paths resolve
    fs.writeFileSync(docPath, '# Test', 'utf-8');

    const sc = emptySidecar('design.md');
    mgr.addThread(sc, threadStub());

    await mgr.writeSidecar(docPath, sc);

    const loaded = await mgr.readSidecar(docPath);
    assert.ok(loaded);
    assert.strictEqual(loaded!.doc, 'design.md');
    assert.strictEqual(loaded!.version, '1.0');
    assert.strictEqual(loaded!.comments.length, 1);
    assert.strictEqual(loaded!.comments[0].anchor.sectionSlug, 'introduction');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readSidecar returns null when file does not exist', async () => {
    const mgr = makeSidecar();
    const result = await mgr.readSidecar('/nonexistent/path/doc.md');
    assert.strictEqual(result, null);
  });

  test('readSidecar returns null for malformed JSON', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'doc.md');
    const sidecarPath = mgr.getSidecarPath(docPath);

    fs.writeFileSync(sidecarPath, '{ this is not valid json }', 'utf-8');

    const result = await mgr.readSidecar(docPath);
    assert.strictEqual(result, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readSidecar returns null for invalid schema (missing doc)', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'doc.md');
    const sidecarPath = mgr.getSidecarPath(docPath);

    fs.writeFileSync(sidecarPath, JSON.stringify({ version: '1.0', comments: [] }), 'utf-8');

    const result = await mgr.readSidecar(docPath);
    assert.strictEqual(result, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readSidecar returns null for wrong version', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'doc.md');
    const sidecarPath = mgr.getSidecarPath(docPath);

    fs.writeFileSync(sidecarPath, JSON.stringify({ doc: 'doc.md', version: '2.0', comments: [] }), 'utf-8');

    const result = await mgr.readSidecar(docPath);
    assert.strictEqual(result, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readSidecar returns null when comments is not an array', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'doc.md');
    const sidecarPath = mgr.getSidecarPath(docPath);

    fs.writeFileSync(sidecarPath, JSON.stringify({ doc: 'doc.md', version: '1.0', comments: 'not-array' }), 'utf-8');

    const result = await mgr.readSidecar(docPath);
    assert.strictEqual(result, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sidecarExists returns correct boolean', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'design.md');

    assert.strictEqual(mgr.sidecarExists(docPath), false);

    // Write a sidecar
    const sc = emptySidecar('design.md');
    await mgr.writeSidecar(docPath, sc);

    assert.strictEqual(mgr.sidecarExists(docPath), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── onDidChange event ────────────────────────────────────────────

  test('writeSidecar fires onDidChange with correct origin', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'design.md');
    const sc = emptySidecar('design.md');

    let firedDocPath: string | null = null;
    let firedOrigin: string | null = null;
    mgr.onDidChange((e) => {
      firedDocPath = e.docPath;
      firedOrigin = e.origin;
    });

    await mgr.writeSidecar(docPath, sc, 'editor');

    assert.ok(firedDocPath, 'onDidChange should have fired');
    assert.strictEqual(firedDocPath, docPath);
    assert.strictEqual(firedOrigin, 'editor');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeSidecar defaults origin to internal', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'design.md');
    const sc = emptySidecar('design.md');

    let firedOrigin: string | null = null;
    mgr.onDidChange((e) => {
      firedOrigin = e.origin;
    });

    await mgr.writeSidecar(docPath, sc);

    assert.strictEqual(firedOrigin, 'internal');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Editor→Sidecar→Preview sync contract ────────────────────────

  test('addThread returns thread with sidecar-assigned ID usable for addReply', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    const created = mgr.addThread(sc, threadStub());

    // The ID returned by addThread must be the same one stored in comments
    assert.strictEqual(sc.comments[0].id, created.id);

    // addReply using the RETURNED id must succeed
    const reply = mgr.addReply(sc, created.id, {
      author: 'bob',
      body: 'Reply using returned ID',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.ok(reply, 'addReply should succeed when using the id from addThread');
    assert.strictEqual(sc.comments[0].thread.length, 2);
  });

  test('addReply fails when using a different UUID than addThread returned', () => {
    const mgr = makeSidecar();
    const sc = emptySidecar();
    mgr.addThread(sc, threadStub());

    // Using a locally-generated UUID (simulates old bug) should fail
    const wrongId = 'locally-generated-uuid-not-from-sidecar';
    const reply = mgr.addReply(sc, wrongId, {
      author: 'bob',
      body: 'This should not work',
      created: new Date().toISOString(),
      edited: null,
    });

    assert.strictEqual(reply, null, 'addReply must return null for mismatched ID');
  });

  test('editor-origin write fires onDidChange so preview listener runs', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'sync.md');
    const sc = emptySidecar('sync.md');
    mgr.addThread(sc, threadStub());

    // Simulate preview listener: collect only non-preview events
    const editorEvents: string[] = [];
    mgr.onDidChange((e) => {
      if (e.origin !== 'preview') {
        editorEvents.push(e.origin);
      }
    });

    await mgr.writeSidecar(docPath, sc, 'editor');

    assert.strictEqual(editorEvents.length, 1);
    assert.strictEqual(editorEvents[0], 'editor');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('preview-origin write fires onDidChange so editor listener runs', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'sync.md');
    const sc = emptySidecar('sync.md');
    mgr.addThread(sc, threadStub());

    // Simulate editor listener: collect only non-editor events
    const previewEvents: string[] = [];
    mgr.onDidChange((e) => {
      if (e.origin !== 'editor') {
        previewEvents.push(e.origin);
      }
    });

    await mgr.writeSidecar(docPath, sc, 'preview');

    assert.strictEqual(previewEvents.length, 1);
    assert.strictEqual(previewEvents[0], 'preview');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full round-trip: add thread, write, read, reply, write, read', async () => {
    const mgr = makeSidecar();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
    const docPath = path.join(tmpDir, 'roundtrip.md');
    fs.writeFileSync(docPath, '# Test', 'utf-8');

    // Step 1: Create thread and write (simulates editor creating a comment)
    const sc1 = emptySidecar('roundtrip.md');
    const created = mgr.addThread(sc1, threadStub());
    await mgr.writeSidecar(docPath, sc1, 'editor');

    // Step 2: Read back (simulates preview refreshing)
    const sc2 = await mgr.readSidecar(docPath);
    assert.ok(sc2);
    assert.strictEqual(sc2!.comments.length, 1);
    assert.strictEqual(sc2!.comments[0].id, created.id);

    // Step 3: Reply using the id from the file (simulates preview replying)
    const reply = mgr.addReply(sc2!, created.id, {
      author: 'charlie',
      body: 'Reply from preview',
      created: new Date().toISOString(),
      edited: null,
    });
    assert.ok(reply);
    await mgr.writeSidecar(docPath, sc2!, 'preview');

    // Step 4: Read back again (simulates editor reloading)
    const sc3 = await mgr.readSidecar(docPath);
    assert.ok(sc3);
    assert.strictEqual(sc3!.comments[0].thread.length, 2);
    assert.strictEqual(sc3!.comments[0].thread[1].body, 'Reply from preview');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
