import { nowIso, sha256, type Row } from "./common";

export const WORKER_LEASE_SECONDS = 180;
export const WORKER_HEARTBEAT_SECONDS = 30;

export async function expireWorkerOperations(db: D1Database) {
  const stamp = nowIso();
  const legacyBefore = new Date(Date.parse(stamp) - 30 * 60 * 1000).toISOString();
  return db.prepare(
    `update operations set status='interrupted',error='The worker stopped reporting progress. Retry when a worker is online.',
      completed_at=?,updated_at=?
    where execution_target='workstation' and status in ('starting','queued','running') and (
      exists(select 1 from operation_leases l where l.operation_id=operations.operation_id and l.expires_at<=?)
      or (not exists(select 1 from operation_leases l where l.operation_id=operations.operation_id) and updated_at<?)
    )`,
  ).bind(stamp, stamp, stamp, legacyBefore).run();
}

export function workerLeaseStatement(db: D1Database, operationId: string) {
  const stamp = nowIso();
  const expiry = new Date(Date.parse(stamp) + WORKER_LEASE_SECONDS * 1000).toISOString();
  return db.prepare("insert into operation_leases(operation_id,expires_at) values(?,?)").bind(operationId, expiry);
}

export async function createWorkerLease(db: D1Database, operationId: string) {
  await workerLeaseStatement(db, operationId).run();
}

export async function getWorkerLease(db: D1Database, operationId: string) {
  return db.prepare("select * from operation_leases where operation_id=?").bind(operationId).first<Row>();
}

export async function renewWorkerLease(db: D1Database, operationId: string, heartbeat: Row) {
  const stamp = nowIso();
  const expiry = new Date(Date.parse(stamp) + WORKER_LEASE_SECONDS * 1000).toISOString();
  const result = await db.prepare(
    `update operation_leases set worker_id=?,instance_id=?,last_heartbeat_at=?,expires_at=?
    where operation_id=? and expires_at>? and completion_hash is null
      and ((worker_id is null and instance_id is null) or (worker_id=? and instance_id=?))
      and exists(select 1 from operations o where o.operation_id=operation_leases.operation_id
        and o.execution_target='workstation' and o.status in ('starting','running')
        and json_extract(o.payload_json,'$._input_hash')=?)`,
  ).bind(heartbeat.worker_id, heartbeat.instance_id, stamp, expiry, operationId, stamp,
    heartbeat.worker_id, heartbeat.instance_id, heartbeat.input_hash).run();
  return Number(result.meta.changes || 0) === 1;
}

// Defer result writes until the ownership check and terminal transition can run
// in the same D1 transaction. Reads still use the real database.
export function bufferResultWrites(db: D1Database) {
  const writes: D1PreparedStatement[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const buffered = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
          if (property === "run") return async () => {
            writes.push(target);
            return { success: true, results: [], meta: { changes: 1 } };
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
        });
        originals.set(proxy, statement);
        return proxy;
      };
      return wrap(db.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      writes.push(...statements.map((statement) => originals.get(statement) || statement));
      return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db: buffered, writes };
}

export async function commitWorkerCompletion(
  db: D1Database, operation: Row, callback: Row, writes: D1PreparedStatement[],
  status: string, result: unknown, error: string,
) {
  const stamp = nowIso();
  const hash = await sha256(JSON.stringify(callback));
  // A CHECK constraint aborts the whole batch if ownership expired or another
  // callback won. INSERT also fences a missing/deleted lease, unlike UPDATE.
  const guard = db.prepare(
    `insert into operation_leases(operation_id,expires_at,completion_hash,completion_valid)
    values(?,?,?,coalesce((select 1 from operation_leases l join operations o on o.operation_id=l.operation_id
      where l.operation_id=? and l.worker_id=? and l.instance_id=? and l.expires_at>?
        and l.completion_hash is null and o.status in ('starting','running')
        and json_extract(o.payload_json,'$._input_hash')=?),0))
    on conflict(operation_id) do update set completion_hash=excluded.completion_hash,completion_valid=excluded.completion_valid`,
  ).bind(operation.operation_id, stamp, hash, operation.operation_id, callback.worker_id,
    callback.instance_id, stamp, callback.input_hash);
  await db.batch([
    guard, ...writes,
    db.prepare("update operations set status=?,result_json=?,error=?,completed_at=?,updated_at=? where operation_id=?")
      .bind(status, result == null ? null : JSON.stringify(result), error, stamp, stamp, operation.operation_id),
  ]);
}
