# docsAgent: design decisions

Status: draft, living note. Append as answers arrive. Not code.

## Goal
- Answer office-document tasks (SOP, agreements) with citations to source passages.
- Flag conflicts between overlapping documents.
- Suggest revised versions only as reviewed drafts (not written back).
- Scope this iteration: read-only. The agent does not edit Drive documents.

## Status
- User approved (this session): M1 scope = local files only (decision 18); supersession derived from dates with no LLM pass or confirmation step (decision 5). Conflict detection deferred.
- Still open before building: local corpus root, file count, scanned-PDF share, and `.doc` count (Next steps 1).
- Plan written: `docs/superpowers/plans/2026-11-03-docs-agent-m1.md` (12 tasks; Task 1 = corpus measurement, needs the root path). Awaiting user choice of execution approach.
- Renames and moves within a root: user asked for content-hash tracking; adopted. `doc_id` is a stored UUID; renames match by version key (decision 18). Not yet confirmed as final by the user.

## Decisions (binding so far)
1. **Serving on Cloudflare:** Workers for the API, Vectorize for vectors, D1 for chunks, FTS5, metadata, and graph edges. Answer LLM and ingest-pass LLM are GPT-6 Luna via OpenRouter (user choice, cost), not Workers AI.
2. **Source of truth: Google Drive (deferred).** For milestone 1 the source is local files (decision 18); no R2 copy of originals (user choice). When Drive is added: citations pin Drive file ID plus a version key. Native Google Docs use `modifiedTime` / revision metadata plus a hash of the exported snapshot; binary files use `md5Checksum` plus revision ID. Version-key comparison is never revision-ID content equality.
3. **Indexing runs locally** on the user's machine. M1 stages: read local files, convert .doc, OCR scanned PDF pages, chunk, embed, derive supersession edges from dates (no LLM), write to Cloudflare (D1 rows, Vectorize vectors via REST). Drive download is added next iteration.
4. **Read-only access.** Deferred with the Drive source. In M1 the indexer reads local files; the Worker never needs a Drive token.
5. **Governing document is decided by metadata, not vector similarity.** Per document in D1: `topic_key` (M1: the local parent folder path, frozen at ingest; for Drive, the folder ID in the next iteration), document number, issued date (tanggal ditetapkan), effective date (tanggal diundangkan / mulai berlaku), the raw matched date strings, and a supersedes link. Status is derived, not parsed: within a `topic_key`, the document with the latest effective date is active and the rest are superseded. No LLM pass and no confirmation step; derived links are stored as-is.
- **Ambiguity is shown, never silently ranked** (my call, within the approved rule). A `topic_key` is ambiguous when: (1) two or more candidates share the latest effective date; (2) the winner was picked by issued-date fallback while another candidate has a real effective date; or (3) more than one dated document exists and none is clearly latest. Ambiguous documents get `status_confidence = low` and `alternate_candidates` (doc_id, document number, raw date string). The Worker prints them with the answer.
- Undated attachments (lampiran) are flagged unparsable with `status_confidence = low`, never defaulted to newest.
6. **Answer modes:** (a) pick the source and cite it, (b) flag conflicts between overlapping documents (deferred with conflict detection, see Open), (c) suggest a revised version as a draft that cites its basis. Drafts are never applied automatically.
7. **Search design:** hybrid (vector + FTS5), with a document-level index and a separate scope-section index. Keyword aliases for SOP/prosedur and management/pengelolaan.
8. **Language: TypeScript for both the Worker and the local indexer.** Shared chunk schema and types. Same stack as the ticketing repo (VoltAgent on Workers, D1, Vectorize).
9. **Parsers (proposed, not yet tested on your files):** .docx via `mammoth`; .pdf text via `pdfjs-dist`; .doc converted to .docx with LibreOffice headless; native Google Docs via `files.export` to .docx. PDF ingest is per page: extract text first; a page with near-zero characters goes to OCR (`tesseract.js`, `ind` + `eng`, local). The threshold is set after measuring. Signed PDFs: extract text as normal; never re-save or modify a signed file; treat signature fields as metadata, not validity. Permission-restricted PDFs (copy blocked): flag unreadable, do not work around the restriction.
10. **Embedding:** OpenRouter `openai/text-embedding-3-small`, 1536 dims, chosen by user. Vectorize has no local emulator. Use a new index, not `recon-learned-cases`.
11. **Approach: chunk vectors in Vectorize (not document cards).** OCR runs per page, only on pages without a text layer, locally (`tesseract.js` or CLI), so page images stay on the user's machine. Visual signature images on digital pages are ignored (text is still extracted).
12. **Local-first run and Vectorize shape.** The indexer is a standalone local extractor that writes vectors directly through the Vectorize REST API, behind a `VectorStore` adapter. Production queries use the `env.VECTORIZE` binding in the Worker. Dev runs with `wrangler dev` on a fixed port with local D1; no dev server is needed for indexing.
13. **ID and re-run contract.** M1: `doc_id` and version key per decision 18. Drive file ID as `doc_id` is deferred with the Drive source. `chunk_id` = doc_id + page + index. A re-run compares the version key first and skips unchanged files before re-embedding. Changed files upsert by `chunk_id` and delete orphaned chunk IDs. Prune and diff run only over rows with the current `root_id` (decision 18); rows from other roots are never touched. Pruned rows are removed from D1 and Vectorize.
14. **Drafts are D1-only.** Suggested revisions are returned in the API response for the user to copy out. The Worker never writes to Drive; decisions 2, 4, and read-only scope stay intact.
15. **OpenRouter provider pinning.** Pin OpenAI as the provider for `openai/gpt-6-luna` and `openai/text-embedding-3-small`, with no fallback across providers. Residency in decision 11 depends on this.
16. **Graph storage: D1 edge tables**, M1 holds supersession edges only (derived from dates, decision 5). Conflict edges are deferred with conflict detection. No Durable Objects or external graph database.
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

## Provisional (non-binding, proxy until real questions exist)
- **Answer and ingest-pass LLM: GPT-6 Luna via OpenRouter** (`openai/gpt-6-luna`, $0.10 in / $0.50 out per 1M tokens). Confirmed by user. Not yet validated on your questions.

## Deferred (user, this session)
- Success bar and real test questions: deferred until the document set is gathered. User prefers feedback-based signals after launch; the pre-launch test set is still needed to choose models.

## Open (to answer)
- Conflict detection (surfacing and acting): deferred to next iteration. Out of scope for M1 per user; not in the M1 pipeline, not in decision 16.
- Native Google Docs: deferred with the Drive source. Milestone 1 uses local .docx/.pdf/.doc files.
- Drive location and native Google Docs handling: deferred to next iteration (Drive source). Milestone 1 uses local files.
- Misplaced documents and the review queue: deferred to next iteration (Drive folder signals; not applicable to local M1).
- Scanned-PDF rate, .doc count, and total size of the local M1 folder. Not measured yet.

## Costs (from Cloudflare pricing pages, Oct 2026)
- Fixed: $5/mo Workers Paid base.
- Per 1,000 queries: about $0.85 LLM (GPT-6 Luna: ~6k input + ~500 output tokens per query, $0.10/$0.50 per 1M). Query embedding is negligible. [INFERENCE: token counts]
- Per 1,000 documents: one-time embedding about $0.20 (`text-embedding-3-small`, assumed $0.02/1M at ~10k tokens per document; OpenRouter price not yet verified). [INFERENCE]
- Ingest-time LLM conflict pass: deferred to next iteration (out of scope for M1). Reference only: about $0.00225 per candidate pair (two full documents at ~10k tokens each, ~500 output, GPT-6 Luna); ~$11 for 1,000 documents at ~5 candidates each. [INFERENCE: candidate count]
- D1 10 GB cap is the scaling limit (about 40k documents at ~250 MB per 1,000).

## Next steps
1. Measure 5–10 real local files: scanned or not, .doc or .docx, page count. Scanned-PDF share decides whether tesseract.js throughput is acceptable.
2. Measure folder mix (how many folders hold mixed topics) when the Drive source is designed next iteration. M1 already uses the local folder path as `topic_key`; the Drive measurement decides whether folder IDs need user overrides.
3. Create the new 1536-dim Vectorize index with `wrangler vectorize create` (embedding confirmed as `text-embedding-3-small`).
4. Vendor `ind` and `eng` traineddata locally so tesseract.js does not fetch over HTTP during indexing.
5. When the document set is gathered: collect test questions and set the bar; then confirm or replace the provisional models.
