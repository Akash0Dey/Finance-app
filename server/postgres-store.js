import pg from 'pg';

function operations(connection) {
  return {
    async all(collection) {
      const { rows } = await connection.query('SELECT body FROM pocket_records WHERE collection = $1 ORDER BY position', [collection]);
      return rows.map((row) => row.body);
    },
    async get(collection, id) {
      const { rows } = await connection.query('SELECT body FROM pocket_records WHERE collection = $1 AND id = $2', [collection, id]);
      return rows[0]?.body ?? null;
    },
    async put(collection, value) {
      await connection.query('INSERT INTO pocket_records (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body', [collection, value.id, JSON.stringify(value)]);
      return value;
    },
    async delete(collection, id) {
      await connection.query('DELETE FROM pocket_records WHERE collection = $1 AND id = $2', [collection, id]);
    },
  };
}

// Accept a pool for isolated PostgreSQL tests. Production uses node-postgres.
export async function createPostgresStore(connectionString, { pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 }) } = {}) {
  // Do not log connection errors: connection strings contain credentials.
  pool.on?.('error', () => console.error('An idle PostgreSQL connection failed.'));
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS pocket_records (
      position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      body JSONB NOT NULL,
      PRIMARY KEY (collection, id)
    )`);
  } catch {
    try { await pool.end(); } catch { /* Preserve the sanitized initialization error. */ }
    throw new Error('Could not initialize PostgreSQL. Check DATABASE_URL, network access, and database permissions.');
  }
  return {
    ...operations(pool),
    async atomic(fn) {
      const client = await pool.connect();
      let releaseError;
      try {
        await client.query('BEGIN');
        // Serialize application transactions, including owner resets, across processes.
        await client.query('SELECT pg_advisory_xact_lock(734901, 1)');
        const result = await fn(operations(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { releaseError = rollbackError; }
        throw error;
      } finally { client.release(releaseError); }
    },
    async close() { await pool.end(); },
  };
}