import pg from "pg";
import {
  type Store, type StoreCollection, type StoreDoc, type StoreFields,
  newId, tsNumOf,
} from "./types.js";

function row(collection: StoreCollection, r: { id: string; fields: StoreFields; ts_num: string | number | null }): StoreDoc {
  const fields = r.fields ?? {};
  const tsNum = r.ts_num !== null && r.ts_num !== undefined ? Number(r.ts_num) : tsNumOf(fields);
  return { id: r.id, collection, fields, tsNum: Number.isFinite(tsNum as number) ? (tsNum as number) : null };
}

/** Plain `pg` + DATABASE_URL. No Supabase SDK. */
export function createPostgresStore(pool: pg.Pool): Store {
  return {
    async get(collection, id) {
      const { rows } = await pool.query(
        "SELECT id, fields, ts_num FROM docs WHERE collection = $1 AND id = $2",
        [collection, id],
      );
      return rows[0] ? row(collection, rows[0]) : null;
    },
    async create(collection, fields, id) {
      const docId = id || newId();
      const ts = tsNumOf(fields) ?? Date.now();
      const { rows } = await pool.query(
        `INSERT INTO docs (collection, id, fields, ts_num)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, fields, ts_num`,
        [collection, docId, JSON.stringify(fields), ts],
      );
      return row(collection, rows[0]);
    },
    async upsert(collection, id, fields) {
      const ts = tsNumOf(fields) ?? Date.now();
      const { rows } = await pool.query(
        `INSERT INTO docs (collection, id, fields, ts_num)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (collection, id) DO UPDATE
           SET fields = EXCLUDED.fields, ts_num = EXCLUDED.ts_num, updated_at = now()
         RETURNING id, fields, ts_num`,
        [collection, id, JSON.stringify(fields), ts],
      );
      return row(collection, rows[0]);
    },
    async patch(collection, id, fields) {
      const { rows } = await pool.query(
        `UPDATE docs
            SET fields = fields || $3::jsonb,
                ts_num = COALESCE($4, ts_num),
                updated_at = now()
          WHERE collection = $1 AND id = $2
          RETURNING id, fields, ts_num`,
        [collection, id, JSON.stringify(fields), tsNumOf(fields)],
      );
      if (!rows[0]) throw new Error(`store patch: ${collection}/${id} not found`);
      return row(collection, rows[0]);
    },
    async remove(collection, id) {
      const { rowCount } = await pool.query(
        "DELETE FROM docs WHERE collection = $1 AND id = $2",
        [collection, id],
      );
      return (rowCount ?? 0) > 0;
    },
    async listNewest(collection, limit) {
      const cap = Math.max(1, Math.min(limit, 200));
      const { rows } = await pool.query(
        `SELECT id, fields, ts_num FROM docs
          WHERE collection = $1
          ORDER BY ts_num DESC NULLS LAST, created_at DESC
          LIMIT $2`,
        [collection, cap],
      );
      return rows.map((r) => row(collection, r));
    },
    async close() { await pool.end(); },
  };
}

export function postgresPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 4 });
}
