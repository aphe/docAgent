import type { Client } from "@libsql/client";

export interface VectorStore {
  upsert(
    vectors: Array<{ id: string; values: number[]; metadata: { docId: string } }>,
  ): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
}

/**
 * libsql-backed VectorStore. Vectors are stored in `chunk_vectors` as
 * F32_BLOB values built with `vector32(?)`, and removed by `chunk_id`.
 */
export class LibsqlVectorStore implements VectorStore {
  constructor(private readonly db: Client) {}

  async upsert(
    vectors: Array<{ id: string; values: number[]; metadata: { docId: string } }>,
  ): Promise<void> {
    if (vectors.length === 0) return;
    await this.db.batch(
      vectors.map((vector) => ({
        sql: `INSERT INTO chunk_vectors (chunk_id, embedding)
              VALUES (?, vector32(?))
              ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding`,
        args: [vector.id, JSON.stringify(vector.values)],
      })),
      "write",
    );
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.batch(
      ids.map((id) => ({
        sql: "DELETE FROM chunk_vectors WHERE chunk_id = ?",
        args: [id],
      })),
      "write",
    );
  }
}
