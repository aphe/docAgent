# docsAgent M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local indexer and Cloudflare Worker that answer SOP and agreement questions from a configurable local folder, with citations, date-derived supersession (with ambiguity shown), and text-only drafts.

**Architecture:** TypeScript on both sides. A local indexer reads a root folder, extracts and OCRs text, chunks, embeds via OpenRouter, derives supersession from dates, and writes D1 rows and Vectorize vectors. A Workers API runs hybrid search (Vectorize + D1 FTS5) and calls GPT-6 Luna via OpenRouter to answer with citations or draft a revision. No Drive access, no write-back.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vectorize, `mammoth`, `pdfjs-dist`, LibreOffice (headless, for `.doc`), `tesseract.js` (`ind` + `eng`, vendored; choice pending Task 1 measurement, spec §11.3), OpenRouter (`openai/text-embedding-3-small`, `openai/gpt-6-luna`, OpenAI provider pinned, no fallback), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-docs-agent-m1-design.md` (M1 design spec; `DECISIONS.md` is its provenance). The plan argues from the spec; executors read both.

## Global Constraints

- Root folder is a required input (CLI argument or config value). No hardcoded path.
- Embedding: `openai/text-embedding-3-small`, 1536 dims, new Vectorize index (not `recon-learned-cases`).
- Answer and ingest LLM: `openai/gpt-6-luna`, OpenAI provider pinned, no fallback.
- Read-only: the Worker never writes to Drive. Drafts are returned in the API response only.
- Signed PDFs: extract text, never re-save. Permission-restricted PDFs: parser sets `unreadable = true`, `reason = "copy-restricted"`, no chunks, not worked around.
- OCR runs locally; page images never leave the machine.
- No auth in M1.

## Review Focus

1. Re-run identity (spec §5, AC 1–3, 9): unchanged re-run is a no-op; rename or move keeps `doc_id`; edit at same path replaces chunks in D1 and Vectorize; another `root_id`'s rows are never pruned.
2. Date supersession (spec §8, AC 5–6): lampiran and undated docs are `unparsable`, never defaulted to newest; ties are `low` with alternates.
3. Extraction failures (spec §6, AC 7): copy-restricted PDF gets `read_error = copy-restricted` in D1 (mapped in Task 7), zero chunks; OCR failure or empty page is flagged, not indexed as empty; OCR makes no network calls (AC 10).
4. Duplicates (spec §5): two identical files in one run → both ingested; the second is flagged `is_duplicate = 1`.
5. Query contract (spec §9, AC 8): no match → no citation, says no source found; stale citation carries `stale = true` and a warning.

---

### Task 0: Repository setup

**Files:**
- Create or modify: `package.json`, `tsconfig.json`; Modify: `.gitignore` (append `.DS_Store`, `node_modules`, `.wrangler`, `.idea/`; the file already exists)
- Create: `indexer/`, `worker/`, `eval/` directories

**Interfaces:**
- Consumes: nothing
- Produces: a git repository at `docsAgent/` with TypeScript, Vitest, and `tsx` installed. Every later task's commit steps run in this repo.

- [ ] **Step 1: Initialize git and install the toolchain**

Run: `git init && npm init -y && npm i -D typescript vitest tsx`
Expected: `.git/` exists; `package.json` lists `typescript`, `vitest`, `tsx`.

- [ ] **Step 2: Add ignores and commit the spec**

```bash
# append only; keep existing entries
grep -qxF ".DS_Store" .gitignore || echo ".DS_Store" >> .gitignore
for p in node_modules .wrangler .idea/; do grep -qxF "$p" .gitignore || echo "$p" >> .gitignore; done
git add .gitignore package.json DECISIONS.md
git commit -m "chore: repo scaffold and spec"
```

Expected: one commit on the default branch.


### Task 1: Corpus measurement

**Files:**
- Create: `indexer/src/measure.ts`
- Create: `indexer/src/cli.ts`
- Test: `indexer/test/measure.test.ts`
- Test fixtures: `indexer/test/fixtures/corpus/` (small docx, digital PDF, scanned PDF, `.doc`)

**Interfaces:**
- Consumes: nothing
- Produces: `measureCorpus(root: string, opts?: { sampleLimit?: number }): Promise<CorpusReport>`; `CorpusReport = { root: string; totalFiles: number; byExtension: Record<string, number>; totalBytes: number; pdfSampled: number; pdfScanned: number; scannedShare: number; estOcrMinutes: number; ocrSecondsPerPage: number; avgPagesPerScannedPdf: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { measureCorpus } from "../src/measure";

test("counts extensions and reports scanned share", async () => {
  const r = await measureCorpus("test/fixtures/corpus", { sampleLimit: 10 });
  expect(r.byExtension[".docx"]).toBe(1);
  expect(r.byExtension[".pdf"]).toBe(2);
  expect(r.pdfSampled).toBe(2);
  expect(r.pdfScanned).toBe(1);
  expect(r.scannedShare).toBeCloseTo(0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/measure.test.ts`
Expected: FAIL with "Cannot find module '../src/measure'"

- [ ] **Step 3: Implement `measureCorpus(root: string, opts?: { sampleLimit?: number }): Promise<CorpusReport>` in `indexer/src/measure.ts`**

Walk `root` recursively, skip hidden entries. Count by lowercased extension and sum bytes. For up to `sampleLimit` PDFs (default 50), extract text per page with `pdfjs-dist`; a page with fewer than 20 non-whitespace characters counts as scanned. A PDF is scanned if more than half its sampled pages are scanned. `estOcrMinutes` = scanned pages across the whole corpus (estimated as `avgPagesPerScannedPdf × count of scanned PDFs`) × `ocrSecondsPerPage` / 60, with `ocrSecondsPerPage` = 3 as an assumption, marked `[INFERENCE]` in the report output.

- [ ] **Step 4: Implement the CLI in `indexer/src/cli.ts`**

`npx tsx src/cli.ts measure <root>` prints the report as JSON to stdout. Exit 1 if `root` is not a directory.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/measure.test.ts`
Expected: PASS

- [ ] **Step 6: Run against the real folder**

Run: `npx tsx indexer/src/cli.ts measure <user-supplied-root>`
Expected: JSON report. Record the output in `DECISIONS.md` Open section, replacing "Not measured yet".

- [ ] **Step 7: Commit**

```bash
git add indexer/src/measure.ts indexer/src/cli.ts indexer/test
git commit -m "feat: corpus measurement CLI"
```

---

### Task 2: Config, root_id, and D1 schema

**Files:**
- Create: `indexer/src/config.ts`
- Create: `worker/migrations/0001_init.sql`
- Test: `indexer/test/config.test.ts`

**Interfaces:**
- Consumes: root path from Task 1 CLI
- Produces: `rootId(absRoot: string): string` (sha256 of absolute path, hex); `loadConfig(argv: string[], env: NodeJS.ProcessEnv): { root: string; rootId: string; openrouterKey: string; vectorizeIndex: "docs-agent-chunks"; ocrMinChars: number }` (`ocrMinChars` default 20; overridable via env)

D1 tables (exact columns):
- `documents(doc_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, path TEXT NOT NULL, topic_key TEXT NOT NULL, version_key TEXT NOT NULL, sha256 TEXT NOT NULL, drive_file_id TEXT, document_number TEXT, issued_date TEXT, effective_date TEXT, raw_date_strings TEXT, status TEXT NOT NULL, status_confidence TEXT NOT NULL, alternate_candidates TEXT, is_duplicate INTEGER NOT NULL DEFAULT 0, read_error TEXT, last_seen_run TEXT NOT NULL)`
- `chunks(chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, page INTEGER NOT NULL, idx INTEGER NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, text TEXT NOT NULL, version_key TEXT NOT NULL)`
- `chunks_fts` FTS5 over `chunks.text`
- `supersedes(doc_id TEXT NOT NULL, supersedes_doc_id TEXT NOT NULL, PRIMARY KEY(doc_id, supersedes_doc_id))`
- `ingest_log(run_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, root_path TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT)`

- [ ] **Step 1: Write the failing test**

```ts
test("rootId is stable for the same absolute path and differs across paths", () => {
  expect(rootId("/a/b")).toBe(rootId("/a/b"));
  expect(rootId("/a/b")).not.toBe(rootId("/a/c"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL with "rootId is not a function" or module not found

- [ ] **Step 3: Implement `rootId` and `loadConfig` in `indexer/src/config.ts`; write `worker/migrations/0001_init.sql` with the tables above**

`loadConfig` throws if no root argument is given.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Apply migration locally**

Run: `npx wrangler d1 migrations apply docs-agent --local`
Expected: "Migrations applied" with `0001_init.sql` listed.

- [ ] **Step 6: Commit**

```bash
git add indexer/src/config.ts indexer/test/config.test.ts worker/migrations
git commit -m "feat: config, root_id, D1 schema"
```

---

### Task 3: Document identity and re-run matching

**Files:**
- Create: `indexer/src/identity.ts`
- Test: `indexer/test/identity.test.ts`

**Interfaces:**
- Consumes: `rootId(absRoot)` (Task 2, the function; the parameter below is named `currentRootId` so it does not shadow it), existing `documents` rows (Task 2 schema)
- Produces: `matchFiles(existing: DocRow[], seen: ScannedFile[], currentRootId: string): MatchPlan`
  - `DocRow = { doc_id: string; root_id: string; path: string; version_key: string }` (columns of `documents` used for matching; Task 2 schema)
  - `ScannedFile = { path: string; versionKey: string; sha256: string }` (path relative to root)
  - `MatchPlan = { unchanged: string[]; newVersion: Array<{ docId: string; file: ScannedFile }>; moved: Array<{ docId: string; oldPath: string; file: ScannedFile }>; added: Array<{ file: ScannedFile; isDuplicate: boolean }>; pruned: string[] }` (`docId` values are doc IDs; `pruned` holds doc IDs with no match under the current `rootId`; `duplicates` is not a field, it is `added.filter(a => a.isDuplicate).length`)

Matching order: (1) by `path` among rows with this `root_id`; same version key → `unchanged`, different → `newVersion`. (2) Unmatched file whose version key equals an unmatched existing row → `moved`. (3) Remaining files → `added`; a file whose version key equals an earlier file in this run is still added, with `isDuplicate: true`. (4) Rows with no match → `pruned`.

- [ ] **Step 1: Write the failing tests**

```ts
test("rename with same bytes is a move, keeps doc_id", () => {
  const plan = matchFiles(
    [{ doc_id: "d1", root_id: "R", path: "a/old.docx", version_key: "v1" }],
    [{ path: "a/new.docx", versionKey: "v1", sha256: "v1" }],
    "R",
  );
  expect(plan.moved).toEqual([{ docId: "d1", oldPath: "a/old.docx", file: expect.objectContaining({ path: "a/new.docx" }) }]);
  expect(plan.pruned).toEqual([]);
  expect(plan.added).toEqual([]);
});

test("rows from another root are never pruned", () => {
  const plan = matchFiles(
    [{ doc_id: "d2", root_id: "OTHER", path: "x.pdf", version_key: "v9" }],
    [],
    "R",
  );
  expect(plan.pruned).toEqual([]);
});

test("same path, changed bytes is newVersion", () => {
  const plan = matchFiles(
    [{ doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" }],
    [{ path: "a.docx", versionKey: "v2", sha256: "v2" }],
    "R",
  );
  expect(plan.newVersion.map(n => n.docId)).toEqual(["d1"]);
});

test("second identical file in one run is a duplicate", () => {
  const plan = matchFiles([], [
    { path: "a.docx", versionKey: "v1", sha256: "v1" },
    { path: "b.docx", versionKey: "v1", sha256: "v1" },
  ], "R");
  expect(plan.added).toEqual([
    { file: expect.objectContaining({ path: "a.docx" }), isDuplicate: false },
    { file: expect.objectContaining({ path: "b.docx" }), isDuplicate: true },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/identity.test.ts`
Expected: FAIL with "matchFiles is not a function" or module not found

- [ ] **Step 3: Implement `matchFiles` in `indexer/src/identity.ts`**

Pure function, no I/O. Follow the matching order above. `docId` for `added` is minted by the caller (UUID), not inside `matchFiles`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/identity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/src/identity.ts indexer/test/identity.test.ts
git commit -m "feat: document identity and re-run matching"
```

---

### Task 4: Parsers and per-page OCR fallback

**Files:**
- Create: `indexer/src/parse/docx.ts`, `indexer/src/parse/pdf.ts`, `indexer/src/parse/doc.ts`, `indexer/src/parse/ocr.ts`, `indexer/src/parse/index.ts`
- Test: `indexer/test/parse.test.ts` (fixtures from Task 1)

**Interfaces:**
- Consumes: file path
- Produces: `parseFile(absPath: string, opts: { ocrMinChars: number }): Promise<ParsedDoc>`
  - `ParsedDoc = { pages: Array<{ page: number; text: string; source: "text" | "ocr" | "none" }>; unreadable: boolean; reason?: "copy-restricted" | "ocr-failed" | "parse-failed" }`
  - `.doc` is converted to `.docx` via `soffice --headless --convert-to docx`; the converted file is written to a temp dir, never next to the original.
  - Signed PDF: read-only; no write calls on the original.
  - Permission-restricted PDF: `unreadable = true`, `reason = "copy-restricted"`, no text returned. `status` stays date-derived, not set by extraction.

- [ ] **Step 1: Write the failing tests**

```ts
test("docx yields one page with its text", async () => {
  const d = await parseFile("test/fixtures/corpus/sample.docx", { ocrMinChars: 20 });
  expect(d.unreadable).toBe(false);
  expect(d.pages[0].text).toContain("Prosedur");
});

test("scanned pdf page falls back to OCR with source=ocr", async () => {
  const d = await parseFile("test/fixtures/corpus/scanned.pdf", { ocrMinChars: 20 });
  expect(d.pages.some(p => p.source === "ocr")).toBe(true);
});

test("copy-restricted pdf is flagged unreadable", async () => {
  const d = await parseFile("test/fixtures/corpus/restricted.pdf", { ocrMinChars: 20 });
  expect(d.unreadable).toBe(true);
  expect(d.reason).toBe("copy-restricted");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/parse.test.ts`
Expected: FAIL with module not found for `parse/index`

- [ ] **Step 3: Implement the parsers**

- `docx.ts`: `mammoth.extractRawText({ path })` → single page.
- `pdf.ts`: `pdfjs-dist` per page; a page with fewer non-whitespace characters than `ocrMinChars` goes to `ocr.ts`.
- `ocr.ts`: `tesseract.js` with `ind+eng`, language data loaded from the vendored local path (Task 9 sets it up); page is rendered to an image in memory, never saved.
- `doc.ts`: LibreOffice conversion to a temp `.docx`, then `docx.ts`.
- `index.ts`: dispatch by extension.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/parse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/src/parse indexer/test/parse.test.ts
git commit -m "feat: parsers with per-page OCR fallback"
```

---

### Task 5: Chunking and chunk IDs

**Files:**
- Create: `indexer/src/chunk.ts`
- Test: `indexer/test/chunk.test.ts`

**Interfaces:**
- Consumes: `ParsedDoc` (Task 4), `docId: string`
- Produces: `chunkDoc(docId: string, doc: ParsedDoc, opts: { maxChars: number }): Chunk[]`
  - `Chunk = { chunkId: string; docId: string; page: number; idx: number; charStart: number; charEnd: number; text: string }`
  - `chunkId = `${docId}:${page}:${idx}``

- [ ] **Step 1: Write the failing test**

```ts
test("chunk ids are doc_id:page:index and offsets map back into page text", () => {
  const chunks = chunkDoc("d1", { pages: [{ page: 1, text: "A".repeat(10), source: "text" }], unreadable: false }, { maxChars: 4 });
  expect(chunks.map(c => c.chunkId)).toEqual(["d1:1:0", "d1:1:1", "d1:1:2"]);
  expect(chunks[1].charStart).toBe(4);
  expect(chunks[1].charEnd).toBe(8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chunk.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `chunkDoc` in `indexer/src/chunk.ts`**

Fixed-size character windows within each page; no cross-page chunks. An unreadable doc returns `[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chunk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/src/chunk.ts indexer/test/chunk.test.ts
git commit -m "feat: page-bounded chunking with stable chunk ids"
```

---

### Task 6: Date extraction and supersession with ambiguity

**Files:**
- Create: `indexer/src/dates.ts`, `indexer/src/supersession.ts`
- Test: `indexer/test/dates.test.ts`, `indexer/test/supersession.test.ts`

**Interfaces:**
- Consumes: `ParsedDoc` pages text (Task 4)
- Produces:
  - `extractDates(text: string): { issued?: string; effective?: string; raw: string[]; isLampiran: boolean }` (ISO `YYYY-MM-DD`; Indonesian month names; `tanggal ditetapkan` → issued, `tanggal diundangkan` / `mulai berlaku` → effective; `isLampiran` from a `LAMPIRAN` heading)
  - `deriveSupersession(docs: DocDates[]): SupersessionResult` where `DocDates = { docId: string; topicKey: string; documentNumber?: string; issued?: string; effective?: string; raw: string[]; isLampiran: boolean }`, `SupersessionResult = { byDoc: Record<string, { status: "active" | "superseded" | "unparsable"; statusConfidence: "high" | "low"; alternates: string[] }>; supersedes: Array<{ docId: string; supersedesDocId: string }> }`

Rules (per `topicKey` group):
- Ranking key = `effective ?? issued`.
- Lampiran or no date → `unparsable`, `low`.
- Latest key unique and winner has real effective date → `active` `high`; others `superseded`.
- Tie on latest effective date → all tied `low`, `alternates` lists the others.
- Winner by issued-date fallback while another candidate has effective date → `low`, `alternates` lists the others.
- More than one dated doc and none clearly latest → `low`.

- [ ] **Step 1: Write the failing tests**

```ts
test("latest effective date is active, earlier is superseded", () => {
  const r = deriveSupersession([
    { docId: "a", topicKey: "sop", issued: "2024-01-01", effective: "2024-02-01", raw: [], isLampiran: false },
    { docId: "b", topicKey: "sop", issued: "2025-01-01", effective: "2025-02-01", raw: [], isLampiran: false },
  ]);
  expect(r.byDoc.b).toEqual({ status: "active", statusConfidence: "high", alternates: [] });
  expect(r.byDoc.a.status).toBe("superseded");
  expect(r.supersedes).toContainEqual({ docId: "b", supersedesDocId: "a" });
});

test("equal latest effective date is low confidence with alternates", () => {
  const r = deriveSupersession([
    { docId: "a", topicKey: "sop", effective: "2025-02-01", raw: [], isLampiran: false },
    { docId: "b", topicKey: "sop", effective: "2025-02-01", raw: [], isLampiran: false },
  ]);
  expect(r.byDoc.a.statusConfidence).toBe("low");
  expect(r.byDoc.a.alternates).toEqual(["b"]);
});

test("undated lampiran is unparsable, never newest", () => {
  const r = deriveSupersession([
    { docId: "a", topicKey: "sop", effective: "2025-02-01", raw: [], isLampiran: false },
    { docId: "l", topicKey: "sop", raw: [], isLampiran: true },
  ]);
  expect(r.byDoc.l.status).toBe("unparsable");
  expect(r.byDoc.a.status).toBe("active");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dates.test.ts test/supersession.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `extractDates` and `deriveSupersession`**

Date regex limited to the Indonesian patterns above; no LLM call. Only the explicit rules above decide status.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/dates.test.ts test/supersession.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/src/dates.ts indexer/src/supersession.ts indexer/test
git commit -m "feat: date extraction and supersession with ambiguity flags"
```

---

### Task 7: Embedding, VectorStore adapter, and writes

**Files:**
- Create: `indexer/src/embed.ts`, `indexer/src/vector-store.ts`, `indexer/src/write.ts`
- Test: `indexer/test/write.test.ts`

**Interfaces:**
- Consumes: `Chunk[]` (Task 5), `MatchPlan` (Task 3), `SupersessionResult` (Task 6)
- Produces:
  - `embedTexts(texts: string[], key: string): Promise<number[][]>` via OpenRouter, model `openai/text-embedding-3-small`, provider pinned to OpenAI, no fallbacks
  - `interface VectorStore { upsert(vectors: Array<{ id: string; values: number[]; metadata: { docId: string } }>): Promise<void>; deleteByIds(ids: string[]): Promise<void> }`
  - `applyRun(db: D1Database, store: VectorStore, plan: MatchPlan, chunksByDoc: Map<string, Chunk[]>, vectors: Map<string, number[]>, supersession: SupersessionResult, runId: string, rootId: string): Promise<void>`
  - `applyRun` deletes orphaned chunk IDs, upserts changed ones, prunes only `pruned` rows (already filtered by `root_id` in Task 3), and writes `ingest_log`.
  - Mapping (only place this is written to D1): `documents.read_error = parsed.unreadable ? parsed.reason : null`. The parser's `reason` is one of `copy-restricted` | `ocr-failed` | `parse-failed`; the parser sets it, `applyRun` only copies it. The parser never writes D1.

- [ ] **Step 1: Write the failing test**

```ts
test("pruned docs remove their chunk vectors and rows", async () => {
  const deleted: string[][] = [];
  const store: VectorStore = { upsert: async () => {}, deleteByIds: async ids => { deleted.push(ids); } };
  // db: in-memory D1 stub seeded with doc "d1" and chunk "d1:1:0"
  await applyRun(db, store, { unchanged: [], newVersion: [], moved: [], added: [], pruned: ["d1"] },
    new Map(), new Map(), { byDoc: {}, supersedes: [] }, "run1", "R");
  expect(deleted).toEqual([["d1:1:0"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/write.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement the three modules**

`embed.ts`: batches of up to 96 texts. `vector-store.ts`: REST implementation of `VectorStore` against the new index. `write.ts`: `applyRun` in one D1 batch per phase.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/write.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/src/embed.ts indexer/src/vector-store.ts indexer/src/write.ts indexer/test/write.test.ts
git commit -m "feat: embedding, vector store adapter, and run writes"
```

---

### Task 8: Indexer entrypoint and dry-run

**Files:**
- Create: `indexer/src/index-run.ts`
- Modify: `indexer/src/cli.ts` (add `index <root>` command)
- Test: `indexer/test/index-run.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces: `runIndex(opts: { root: string; dryRun: boolean; deps: IndexDeps }): Promise<RunSummary>`; `RunSummary = { runId: string; added: number; newVersion: number; moved: number; pruned: number; duplicates: number; unparsable: number; ocrPages: number }`

- [ ] **Step 1: Write the failing test**

```ts
test("dry run reports counts and writes nothing", async () => {
  const summary = await runIndex({ root: "test/fixtures/corpus", dryRun: true, deps: fakeDeps() });
  expect(summary.added).toBeGreaterThan(0);
  expect(fakeDeps().writes).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index-run.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `runIndex` in `indexer/src/index-run.ts`**

Order: scan (sha256, version key) → `matchFiles` → parse/chunk/date-extract only for `added`/`newVersion`/`moved`-with-changes → embed → `deriveSupersession` per `topic_key` over all rows with this `root_id` → `applyRun`. Dry run stops before embed and writes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index-run.test.ts`
Expected: PASS

- [ ] **Step 5: Run dry-run on the real folder**

Run: `npx tsx indexer/src/cli.ts index <user-supplied-root> --dry-run`
Expected: RunSummary printed, `unparsable` and `ocrPages` counts reported.

- [ ] **Step 6: Commit**

```bash
git add indexer/src/index-run.ts indexer/src/cli.ts indexer/test/index-run.test.ts
git commit -m "feat: indexer run with dry-run"
```

---

### Task 9: Vendor OCR traineddata

> **Gated:** run only after Task 1 measurement confirms `tesseract.js` is the OCR choice (spec §11 item 3). If the measurement picks a CLI instead, skip this task and re-plan the OCR interface.

**Files:**
- Create: `indexer/assets/tessdata/ind.traineddata`, `indexer/assets/tessdata/eng.traineddata`
- Modify: `indexer/src/parse/ocr.ts` (set `langPath` to `indexer/assets/tessdata`)

**Interfaces:**
- Consumes: Task 4 `ocr.ts`
- Produces: OCR never fetches language data over HTTP.

- [ ] **Step 1: Write the failing test**

```ts
test("ocr uses local langPath and makes no network calls", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await ocrPage(somePngBuffer(), { langPath: "assets/tessdata" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocr.test.ts`
Expected: FAIL with `fetch` called or `ocrPage` not exported

- [ ] **Step 3: Download and vendor traineddata**

Download `ind.traineddata` and `eng.traineddata` from the tessdata repository into `indexer/assets/tessdata/`. Set `langPath` in `ocr.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ocr.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add indexer/assets/tessdata indexer/src/parse/ocr.ts indexer/test/ocr.test.ts
git commit -m "feat: vendor ind and eng traineddata"
```

---

### Task 10: Create Vectorize index

**Files:** none (infrastructure only)

- [ ] **Step 1: Create the index**

Run: `npx wrangler vectorize create docs-agent-chunks --dimensions 1536 --metric cosine`
Expected: index created with 1536 dimensions. Do not reuse `recon-learned-cases`.

- [ ] **Step 2: Bind it in `worker/wrangler.toml`**

Add `[[vectorize]] binding = "VECTORIZE" index_name = "docs-agent-chunks"`.

- [ ] **Step 3: Verify**

Run: `npx wrangler vectorize info docs-agent-chunks`
Expected: `dimensions: 1536`.

- [ ] **Step 4: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore: bind docs-agent-chunks vectorize index"
```

---

### Task 11: Worker query API (hybrid search, answer, draft)

**Files:**
- Create: `worker/src/search.ts`, `worker/src/answer.ts`, `worker/src/index.ts`
- Test: `worker/test/search.test.ts`, `worker/test/answer.test.ts`

**Interfaces:**
- Consumes: D1 (Task 2 schema), VECTORIZE binding (Task 10), embedding (Task 7 `embedTexts` shape)
- Produces:
  - `hybridSearch(env: Env, query: string, opts: { topK: number }): Promise<Hit[]>`; `Hit = { chunkId: string; docId: string; page: number; charStart: number; charEnd: number; text: string; score: number; status: "active" | "superseded" | "unparsable"; statusConfidence: "high" | "low"; alternates: string[]; stale: boolean }`. Keyword fallback runs FTS5 for exact names and numbers. Results merged by reciprocal rank fusion.
  - `answer(env: Env, query: string, mode: "answer" | "draft"): Promise<AnswerResponse>`; `AnswerResponse = { text: string; citations: Citation[]; alternates: string[]; warnings: string[]; draft?: string }`; `Citation = { chunkId: string; docId: string; path: string; page: number; charStart: number; charEnd: number; status: "active" | "superseded" | "unparsable"; statusConfidence: "high" | "low"; stale: boolean }`. `draft` only in `mode: "draft"`. Response contains no Drive reference.
  - `POST /query` body `{ query: string; mode: "answer" | "draft" }`.

Behavior: no hit → `text` says no source found, `citations: []`. `stale` hits → warning. `status_confidence = low` or non-empty `alternates` → warning listing them.

- [ ] **Step 1: Write the failing tests**

```ts
test("no hits yields no citations and no invented source", async () => {
  const r = await answer(envWithNoHits(), "prosedur cuti", "answer");
  expect(r.citations).toEqual([]);
  expect(r.text).toMatch(/tidak ditemukan|no source/i);
});

test("low-confidence active doc surfaces alternates as a warning", async () => {
  const r = await answer(envWithTieHits(), "SOP cuti", "answer");
  expect(r.alternates).toEqual(["doc-b"]);
  expect(r.warnings.length).toBeGreaterThan(0);
});

test("stale citation is marked stale in warnings", async () => {
  const hits = await hybridSearch(envWithStaleChunk(), "cuti", { topK: 5 });
  expect(hits.find(h => h.stale)).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run` (in `worker/`)
Expected: FAIL with module not found for `answer` and `hybridSearch`

- [ ] **Step 3: Implement search, answer, and route**

Keep the system prompt short: answer only from supplied passages; cite by `chunkId`; draft mode returns text only. Chat history and auth are out of scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` (in `worker/`)
Expected: PASS

- [ ] **Step 5: Smoke run**

Run: `npx wrangler dev --remote`, then `curl -X POST localhost:8787/query -d '{"query":"...","mode":"answer"}' -H 'content-type: application/json'` against the real indexed corpus.
Expected: JSON with `citations` pointing to real `chunkId`s and `text` that cites them.

- [ ] **Step 6: Commit**

```bash
git add worker/src worker/test
git commit -m "feat: hybrid search, answer, and draft endpoint"
```

---

### Task 12: Validation set and model confirmation

**Files:**
- Create: `eval/questions.yaml` (user supplies questions)
- Create: `eval/run.ts`

**Interfaces:**
- Consumes: `POST /query` (Task 11)
- Produces: `runEval(questions: Array<{ q: string; expectedDocs: string[] }>): Promise<{ recallAt5: number; citationAccuracy: number; perQuestion: Array<{ q: string; hit: boolean; citedDocs: string[] }> }>`

Blocked until the user supplies 10–20 test questions with expected documents (Deferred in the spec). Do not invent questions.

- [ ] **Step 1: Write the failing test**

```ts
test("recall@5 counts a question as hit when an expected doc is in top 5", async () => {
  const r = await runEval([{ q: "x", expectedDocs: ["doc-a"] }], { search: async () => ["doc-a", "doc-b"] });
  expect(r.recallAt5).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run eval`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `runEval`**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run eval`
Expected: PASS

- [ ] **Step 5: Run against the real questions**

Run: `npx tsx eval/run.ts eval/questions.yaml`
Expected: recall and citation accuracy printed. Compare to the success bar set with the user before confirming or replacing GPT-6 Luna and `text-embedding-3-small`.

- [ ] **Step 6: Commit**

```bash
git add eval
git commit -m "feat: validation harness"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-03-docs-agent-m1.md`. Please review the plan. Task 1 needs the root folder path, and Task 12 needs your test questions. Which execution approach would you prefer?

- **Subagent-driven**: a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native**: I implement every task myself in this session, then one fresh reviewer checks the whole branch. Cheapest and fastest; no independent review until the end.

**For this plan I recommend Subagent-driven**, because the tasks depend on each other's interfaces (identity → write → worker), there are twelve of them, and a shipped mistake would wipe or misattribute an index. Does the plan capture what you want, and which approach should we use?
