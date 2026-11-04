# docsAgent M1 Design Spec

**Status:** Draft. Awaiting user approval. No build until approved and the corpus is measured.
**Source decisions:** `DECISIONS.md` (decisions 1–18). This spec restates them as design; where they conflict, `DECISIONS.md` wins until this spec is approved, then this spec supersedes it.

## 1. Purpose

Answer questions about SOP and agreement documents with citations from a local document folder. Show the effective (latest) version and flag ambiguity. Return revised drafts as text only.

## 2. Scope

In M1:
- Local files only, under one configurable root folder.
- Formats: `.docx`, `.pdf` (digital and scanned), `.doc` (converted via LibreOffice).
- Search: meaning-based (vectors) with keyword fallback (FTS5) for exact names and numbers.
- Answers with citations to document, page, and character range.
- Supersession derived from dates, with ambiguity shown.
- Drafts returned in the API response only.

Out of scope in M1:
- Google Drive (iteration 2, via adapter swap).
- Any write to source files.
- Conflict detection between documents (deferred).
- Authentication and multi-user access.
- Chat history.

## 3. Architecture

Two components sharing a D1 database and a Vectorize index.

- **Indexer** (local Node process, `indexer/`): scans the root, parses, OCRs scanned pages locally, chunks, extracts dates, derives supersession, embeds, and writes D1 and Vectorize.
- **Worker API** (Cloudflare Worker, `worker/`): hybrid search and LLM answer or draft.

Models via OpenRouter, OpenAI provider pinned, no fallback:
- Embedding: `openai/text-embedding-3-small`, 1536 dimensions.
- Answer and draft: `openai/gpt-6-luna`.

## 4. Data model

D1 tables:
- `documents`: `doc_id` (UUID, stored), `root_id`, `path` (relative to root), `topic_key` (parent directory, relative), `version_key` (sha256 of bytes), `sha256`, `drive_file_id` (nullable, for iteration 2), `document_number`, `issued_date`, `effective_date`, `raw_date_strings`, `status` (`active` | `superseded` | `unparsable`; date-derived only), `status_confidence` (`high` | `low`), `alternate_candidates`, `is_duplicate`, `read_error` (nullable: `copy-restricted` | `ocr-failed` | `parse-failed`; extraction-derived only), `last_seen_run`.
- `chunks`: `chunk_id` (`doc_id:page:idx`), `doc_id`, `page`, `idx`, `char_start`, `char_end`, `text`, `version_key`.
- `chunks_fts`: FTS5 over `chunks.text`.
- `supersedes`: `doc_id`, `supersedes_doc_id`.
- `ingest_log`: `run_id`, `root_id`, `root_path`, `started_at`, `finished_at`.

Vectorize: one vector per chunk, id = `chunk_id`, metadata `doc_id`. Index `docs-agent-chunks`, 1536 dimensions, cosine. Not the existing `recon-learned-cases` index.

## 5. Identity and re-run behavior

- `root_id` = sha256 of the absolute root path. Every document row carries it. Prune and diff filter by it.
- `doc_id` is a UUID minted at first ingest, stored on the row. It does not depend on path.
- Re-run matching, in order:
  1. Same `path` under the current `root_id`: unchanged if version key matches; new version if not.
  2. No path match: a row not seen this run with the same version key → moved or renamed. Update `path` and `topic_key`, keep `doc_id`.
  3. Otherwise: new document.
- Two files with identical bytes in one run: the second is ingested as new and flagged `is_duplicate`.
- A new version replaces its chunks by upsert on `chunk_id`. Chunks no longer produced are deleted from D1 and Vectorize.
- Moving the whole root is a new `root_id`. Its rows are not matched to the old root.

## 6. Parsing and OCR

- `.docx`: `mammoth` raw text, one page.
- `.pdf`: `pdfjs-dist` per page. A page with fewer non-whitespace characters than `ocrMinChars` goes to OCR.
- OCR: `tesseract.js` with `ind+eng`, traineddata vendored locally. Page images are rendered in memory and never saved. Language data is never fetched over the network.
- `.doc`: LibreOffice headless converts to a temp `.docx`, outside the source folder.
- Signed PDFs: read text only; never re-save the original.
- Copy-restricted PDFs: `read_error = copy-restricted`, no chunks. Not worked around. `status` is still derived from dates; an unreadable document is not given a status it can't justify.
- OCR failure or empty result: the page is flagged, not indexed as empty.

The OCR tool choice (`tesseract.js` vs CLI) is confirmed only by the corpus measurement (section 11).

## 7. Chunking

Fixed character windows inside each page. No chunk crosses a page boundary. `chunkId = doc_id:page:idx`. Offsets `char_start` and `char_end` map back into the page text for citations.

## 8. Dates and supersession

Dates are extracted with Indonesian patterns (`tanggal ditetapkan` → issued; `tanggal diundangkan` / `mulai berlaku` → effective; month names in Indonesian). No LLM pass.

Grouping: by `topic_key`. Ranking key: `effective_date`, falling back to `issued_date`.

Rules:
- Lampiran (annex) or no parsable date → `unparsable`, confidence `low`. Never defaulted to newest.
- Single latest winner with a real effective date → `active`, confidence `high`; others `superseded`.
- Tie on latest effective date → all tied documents `low`, each lists the others in `alternate_candidates`.
- Winner chosen by issued-date fallback while another candidate has an effective date → `low`, alternates listed.
- More than one dated document and none clearly latest → `low`.

Supersession is shown, not silently ranked. The user approved date-based supersession with no confirmation step.

## 9. API

`POST /query`, body `{ query: string, mode: "answer" | "draft" }`.

Response:
```
{ text: string, citations: Citation[], alternates: string[], warnings: string[], draft?: string }
```
`Citation`: `chunk_id`, `doc_id`, `path`, `page`, `char_start`, `char_end`, `status`, `status_confidence`, `stale`.

Behavior:
- No relevant chunk → `text` says no source was found; `citations` is empty. No invented citation.
- Any `status_confidence = low` or non-empty `alternates` → a warning listing them.
- A citation whose `doc_id` version changed since indexing → `stale = true` and a warning.
- `mode: "draft"` → `draft` contains the revised text. Nothing is written to disk or Drive.

Search: vector top-K from Vectorize merged with FTS5 top-K by reciprocal rank fusion.

## 10. Acceptance criteria

1. Indexing a root twice with no changes: second run reports zero added, zero new versions, zero pruned.
2. Renaming a file within the root keeps its `doc_id`; its `path` and `topic_key` update.
3. Editing a file at the same path creates a new version; the old version's chunks are gone from D1 and Vectorize.
4. Two identical files in one run: both ingested; the second is flagged `is_duplicate = 1`.
5. A lampiran and an undated document are `unparsable`, not `active`.
6. Two documents with the same latest effective date are both `low` with alternates.
7. A copy-restricted PDF has `read_error = copy-restricted` and produces no chunks.
8. A query with no match returns no citations and says no source was found.
9. Changing the root path does not prune rows of another `root_id`.
10. OCR makes no network calls.
11. Recall@5 and citation accuracy on the user's test questions meet the success bar (section 12).

## 11. Open items (must be resolved before build)

1. Local root path. Needed for corpus measurement.
2. Corpus measurement: file count, extension mix, scanned-PDF share, `.doc` count, estimated OCR minutes. Result recorded here.
3. OCR choice (`tesseract.js` vs CLI) decided from section 2 measurement.
4. Test questions with expected documents: 10–20, supplied by the user.
5. Success bar for recall@5 and citation accuracy.
6. Confirm the rename and move default (section 5).

## 12. Success bar

To be set with the user after test questions exist. Until then, no threshold is claimed.

## 13. Costs (reference, `[INFERENCE]`)

- Query: about $0.85 per 1,000 queries.
- Embedding: about $0.20 per 1,000 documents.
- Conflict pass (deferred): about $11 per 1,000 documents.
Unverified against real files.
