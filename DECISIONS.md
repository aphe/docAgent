# docsAgent: design decisions

Status: draft, living note. Append as answers arrive. Not code.

## Goal
- Answer office-document tasks (SOP, agreements) with citations to source passages.
- Flag conflicts between overlapping documents.
- Suggest revised versions only as reviewed drafts (not written back).
- Scope this iteration: read-only. The agent does not edit Drive documents.

## Status
- User approved (this session): M1 scope = local files only (decision 18); supersession derived from dates with no LLM pass or confirmation step (decision 5). Conflict detection deferred.
- Local corpus root: `data-files/` in the repo (user choice; `docs/` holds superpowers specs and plans). Contents git-ignored, `data-files/README.md` tracked so the root exists on clone. `data/` (the libsql index) git-ignored. Still open: test questions and success bar (Next steps 3). Non-PDF and no-text-layer shares: Task 1 measurement, not yet run. OCR and `.docx`/`.doc` are out of M1 (decision 19).
- Plan written: `docs/superpowers/plans/2026-11-03-docs-agent-m1.md` (12 tasks; Task 1 = corpus measurement, needs the root path). Awaiting user choice of execution approach.
- Renames and moves within a root: user asked for content-hash tracking; adopted. `doc_id` is a stored UUID; renames match by version key (decision 18). Not yet confirmed as final by the user.

## Decisions (binding so far)
1. **Serving (superseded by 19):** was Cloudflare Workers, Vectorize, D1. Now local VoltAgent + libsql. Answer LLM and ingest-pass LLM remain GPT-6 Luna via OpenRouter.
2. **Source of truth: Google Drive (deferred).** For milestone 1 the source is local files (decision 18); no R2 copy of originals (user choice). When Drive is added: citations pin Drive file ID plus a version key. Native Google Docs use `modifiedTime` / revision metadata plus a hash of the exported snapshot; binary files use `md5Checksum` plus revision ID. Version-key comparison is never revision-ID content equality.
3. **Indexing runs locally** on the user's machine. M1 stages: read local PDFs, chunk, embed, derive supersession edges from dates (no LLM), write to the local libsql file `data/docs-agent.db`. Superseded in part by 19 (no OCR, no .doc). Drive download is added next iteration.
4. **Read-only access.** Deferred with the Drive source. In M1 the indexer reads local files; the Worker never needs a Drive token.
5. **Governing document is decided by metadata, not vector similarity.** Per document in D1: `topic_key` (M1: the local parent folder path, frozen at ingest; for Drive, the folder ID in the next iteration), document number, issued date (tanggal ditetapkan), effective date (tanggal diundangkan / mulai berlaku), the raw matched date strings, and a supersedes link. Status is derived, not parsed: within a `topic_key`, the document with the latest effective date is active and the rest are superseded. No LLM pass and no confirmation step; derived links are stored as-is.
- **Ambiguity is shown, never silently ranked** (my call, within the approved rule). A `topic_key` is ambiguous when: (1) two or more candidates share the latest effective date; (2) the winner was picked by issued-date fallback while another candidate has a real effective date; or (3) more than one dated document exists and none is clearly latest. Ambiguous documents get `status_confidence = low` and `alternate_candidates` (doc_id, document number, raw date string). The Worker prints them with the answer.
- Undated attachments (lampiran) are flagged unparsable with `status_confidence = low`, never defaulted to newest.
6. **Answer modes:** (a) pick the source and cite it, (b) flag conflicts between overlapping documents (deferred with conflict detection, see Open), (c) suggest a revised version as a draft that cites its basis. Drafts are never applied automatically.
7. **Search design:** hybrid (vector + FTS5), with a document-level index and a separate scope-section index. Keyword aliases for SOP/prosedur and management/pengelolaan.
8. **Language: TypeScript for the indexer and the VoltAgent API.** Superseded by 19 (was: same stack as the ticketing repo on Workers).
9. **Parsers (superseded by 19):** PDF text via `pdfjs-dist` only. `.docx` (mammoth), `.doc` (LibreOffice), and OCR (tesseract.js) are removed from M1.
10. **Embedding:** OpenRouter `openai/text-embedding-3-small`, 1536 dims, chosen by user. Stored in libsql `F32_BLOB(1536)` (decision 19).
11. **Approach: chunk vectors (not document cards).** Vectors live in libsql. OCR is removed (decision 19); pages with no text layer are flagged `no-text-layer`, not indexed.
12. **Local-first run (superseded by 19):** the indexer writes libsql directly. No Vectorize REST API or Cloudflare binding. The `VectorStore` interface is kept, with a libsql implementation.
13. **ID and re-run contract.** M1: `doc_id` and version key per decision 18. Drive file ID as `doc_id` is deferred with the Drive source. `chunk_id` = doc_id + page + index. A re-run compares the version key first and skips unchanged files before re-embedding. Changed files upsert by `chunk_id` and delete orphaned chunk IDs. Prune and diff run only over rows with the current `root_id` (decision 18); rows from other roots are never touched. Pruned rows are removed from D1 and Vectorize.
14. **Drafts are not persisted.** Suggested revisions are returned in the API response for the user to copy out. Nothing is written to disk or Drive.
15. **OpenRouter provider pinning.** Pin OpenAI as the provider for `openai/gpt-6-luna` and `openai/text-embedding-3-small`, with no fallback across providers. Residency in decision 11 depends on this.
16. **Graph storage: libsql edge tables**, M1 holds supersession edges only (derived from dates, decision 5). Conflict edges are deferred. No external graph database. Superseded in part by 19 (was D1).
17. **Auth and chat history are out of scope for milestone 1.** The chat platform is not decided; milestone 1 uses the VoltOps platform.
18. **Milestone 1 source is local files; Drive becomes an adapter in iteration 2.** The indexer reads a local folder. Local substitutes for Drive identifiers:
- The local root is configurable: the indexer takes it as a required input (CLI argument or config value), with no hardcoded path. The user supplies it at first run. Each run records the root in the ingest log; `topic_key` and `path` are stored relative to that root.
- Every document row stores `root_id` (hash of the absolute root path). The ingest log is keyed by `root_id`, so the root recorded per run is queryable. All prune and diff queries filter by `root_id`.
- Renames and moves within a root keep `doc_id` (matched by content hash, see matching rule below). A moved file's `topic_key` updates, so both the old and new supersession groups are recomputed in that run. Moving the whole root is a new `root_id`; its rows are not matched to the old root.
- `doc_id` = UUID minted at first ingest and stored on the row (Drive: file ID). It does not depend on path, so it survives renames and moves within a root.
- Matching on re-run: (1) by path under the current `root_id`; (2) if no path match, by version key among rows not seen this run → rename or move: update `path` and `topic_key`, keep `doc_id`, log the change; (3) otherwise a new document. If two files share bytes in one run, the second is ingested as new and flagged duplicate.
- Version key = sha256 of file bytes (Drive: `md5Checksum` / revision ID / `modifiedTime` for native Docs). Hashed on every run. Same `doc_id` with a changed hash = a new version: its chunks are replaced by upsert on `chunk_id`. mtime is not used; it changes without content changes.
- `topic_key` = parent directory path relative to the root; updated when the file moves (Drive: folder ID).
- Citation = `doc_id` + page + character offset range, resolved against the stored chunk text. Pinned to the version key; if the key changed, the citation is marked stale.
- Each document row stores `sha256(file bytes)` as a column, and gets a nullable `drive_file_id` column (empty in M1). Iteration 2 matches existing rows to Drive files by content hash and fills `drive_file_id` instead of re-ingesting, so `doc_id` stays the same and nothing is double-ingested.
- Iteration 2 swaps the source adapter; the chunk schema, D1 keys, and citation shape stay the same.
19. **Stack and scope re-sync (user, 2026-11-03).** One VoltAgent app (`@voltagent/core`, `@voltagent/server-hono`, `@voltagent/libsql`) on one libsql file `data/docs-agent.db`: chunks, FTS5, native vectors (`F32_BLOB(1536)`, `vector_top_k`, cosine), and edges. No Cloudflare, D1, Vectorize, or Wrangler. M1 indexes PDF only. No OCR. `.docx`, `.doc`, and native Google Docs are out of M1. A PDF page with no text layer gets `read_error = no-text-layer` and is not indexed as empty. Supersedes decisions 1, 3, 8, 9, 11, 12, 14, 16 where they name Cloudflare, D1, Vectorize, OCR, or non-PDF parsers.

## Provisional (non-binding, proxy until real questions exist)
- **Answer and ingest-pass LLM: GPT-6 Luna via OpenRouter** (`openai/gpt-6-luna`, $0.10 in / $0.50 out per 1M tokens). Confirmed by user. Not yet validated on your questions.

## Deferred (user, this session)
- Success bar and real test questions: deferred until the document set is gathered. User prefers feedback-based signals after launch; the pre-launch test set is still needed to choose models.

## Open (to answer)
- Conflict detection (surfacing and acting): deferred to next iteration. Out of scope for M1 per user; not in the M1 pipeline, not in decision 16.
- Native Google Docs and `.docx`/`.doc`: deferred. M1 is PDF only (decision 19).
- Drive location and native Google Docs handling: deferred to next iteration (Drive source). Milestone 1 uses local files.
- Misplaced documents and the review queue: deferred to next iteration (Drive folder signals; not applicable to local M1).
- Non-PDF share and no-text-layer PDF share of the local M1 folder: measured by Task 1 (`measureCorpus`). Not yet run.

## Costs (OpenRouter; local infrastructure)
- Fixed: none. One local libsql file.
- Per 1,000 queries: about $0.85 LLM (GPT-6 Luna: ~6k input + ~500 output tokens per query, $0.10/$0.50 per 1M). Query embedding is negligible. [INFERENCE: token counts]
- Per 1,000 documents: one-time embedding about $0.20 (`text-embedding-3-small`, assumed $0.02/1M at ~10k tokens per document; OpenRouter price not yet verified). [INFERENCE]
- Ingest-time LLM conflict pass: deferred to next iteration (out of scope for M1). Reference only: about $0.00225 per candidate pair (two full documents at ~10k tokens each, ~500 output, GPT-6 Luna); ~$11 for 1,000 documents at ~5 candidates each. [INFERENCE: candidate count]
- Storage: one local libsql file. Scale limit is local disk, not D1's 10 GB cap (obsolete under decision 19).

## Next steps
1. Run Task 1 corpus measurement on the local root: PDF count, non-PDF extensions, no-text-layer PDF share.
2. Measure folder mix when the Drive source is designed next iteration.
3. When the document set is gathered: collect test questions and set the bar; then confirm or replace the provisional models.
