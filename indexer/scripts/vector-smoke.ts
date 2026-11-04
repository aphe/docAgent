import { openDb } from "../src/db.js";
import { LibsqlVectorStore } from "../src/vector-store.js";

async function main() {
  const db = await openDb(":memory:");
  const store = new LibsqlVectorStore(db);

  const dim = 1536;

  const v1 = new Array(dim).fill(0);
  v1[0] = 1.0;

  const v2 = new Array(dim).fill(0);
  v2[1] = 1.0;

  const query = new Array(dim).fill(0);
  query[0] = 1.0;

  await store.upsert([
    { id: "chunk-1", values: v1, metadata: { docId: "doc-1" } },
    { id: "chunk-2", values: v2, metadata: { docId: "doc-2" } },
  ]);

  const result = await db.execute({
    sql: "SELECT chunk_id FROM chunk_vectors WHERE rowid IN (SELECT rowid FROM vector_top_k('chunk_vectors_idx', vector32(?), 1))",
    args: [JSON.stringify(query)],
  });

  if (result.rows.length > 0) {
    console.log(String(result.rows[0].chunk_id));
  } else {
    console.log("No results");
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
