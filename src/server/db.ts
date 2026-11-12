import pg from 'pg';

export type Database = pg.Pool;
export type Transaction = pg.PoolClient;

export async function transaction<T>(pool: Database, action: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createPool(connectionString = process.env.DATABASE_URL, max = 10): Database {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', error => {
    try {
      const code = (error as NodeJS.ErrnoException)?.code;
      console.error(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'Database connection error');
    } catch {}
  });
  return pool;
}
