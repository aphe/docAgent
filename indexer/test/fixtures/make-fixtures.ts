/**
 * Generates the corpus fixtures used by indexer/test/measure.test.ts.
 *
 * Run with: pnpm exec tsx indexer/test/fixtures/make-fixtures.ts
 *
 * The generated files are committed so the test does not depend on this script
 * at run time. Re-run only when the fixture set needs to change.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

const here = fileURLToPath(new URL(".", import.meta.url));
const corpus = join(here, "corpus");

await mkdir(corpus, { recursive: true });
await mkdir(join(corpus, ".hidden-dir"), { recursive: true });

async function addTextPage(doc: PDFDocument, text: string): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, font, size: 12 });
}

// 1. digital.pdf: two pages with a real text layer.
{
  const doc = await PDFDocument.create();
  await addTextPage(doc, "Digital fixture page one. This text is extractable.");
  await addTextPage(doc, "Digital fixture page two. More extractable text.");
  await writeFile(join(corpus, "digital.pdf"), await doc.save());
}

// 2. no-text.pdf: one page with no text layer (an empty page).
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await writeFile(join(corpus, "no-text.pdf"), await doc.save());
}

// 3. copy-restricted.pdf: a real encrypted PDF with owner-only permissions.
//    Empty user password => opens without a password; copying is denied.
{
  const doc = await PDFDocument.create();
  await addTextPage(
    doc,
    "Copy-restricted fixture. Text exists but copying is not permitted.",
  );
  doc.encrypt({
    userPassword: "",
    ownerPassword: "owner-secret",
    permissions: { copying: false },
  });
  await writeFile(join(corpus, "copy-restricted.pdf"), await doc.save());
}

// 4. one.docx: placeholder. Measurement counts extensions and never parses it.
await writeFile(
  join(corpus, "one.docx"),
  "Placeholder .docx fixture. Task 1 measures extensions only.\n",
);

// 5. Hidden entries: measureCorpus must skip both the file and the directory.
{
  const doc = await PDFDocument.create();
  await addTextPage(doc, "Hidden file that must not be counted.");
  await writeFile(join(corpus, ".hidden.pdf"), await doc.save());
}
{
  const doc = await PDFDocument.create();
  await addTextPage(doc, "Hidden directory file that must not be counted.");
  await writeFile(join(corpus, ".hidden-dir", "nested.pdf"), await doc.save());
}

console.log(`Fixtures written to ${corpus}`);
