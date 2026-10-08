import assert from 'node:assert/strict';
import { openSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { externalFile, privateFile } from './demo-safety.ts';

// Explicit schemas/columns: never execute SQL supplied by the input database.
// Deployment bindings, receipts, payouts, outboxes and outstanding challenges
// belong to the old operational instance and must NOT cross this boundary.
const TABLES = [
  { name:'app_attest_keys', columns:'key_id,public_key_pem,app_id,environment,counter,validation_category,bundle_version',
    schema:'key_id TEXT PRIMARY KEY, public_key_pem TEXT NOT NULL, app_id TEXT NOT NULL, environment TEXT NOT NULL, counter INTEGER NOT NULL, validation_category INTEGER, bundle_version TEXT' },
  { name:'observer_enrollments', columns:'key_id,commitment,observer_class,leaf_index,leaf',
    schema:'key_id TEXT PRIMARY KEY, commitment TEXT NOT NULL UNIQUE, observer_class INTEGER NOT NULL CHECK(observer_class BETWEEN 1 AND 3), leaf_index INTEGER NOT NULL UNIQUE, leaf TEXT NOT NULL' },
  { name:'observer_merkle_nodes', columns:'level,node_index,value',
    schema:'level INTEGER NOT NULL, node_index INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(level,node_index)' },
  { name:'observer_roots', columns:'revision,root,leaf_count,created_at',
    schema:'revision INTEGER PRIMARY KEY, root TEXT NOT NULL, leaf_count INTEGER NOT NULL, created_at INTEGER NOT NULL' },
  { name:'observer_enrollment_events', columns:'sequence,key_id,commitment,action,root_revision,created_at',
    schema:"sequence INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT NOT NULL, commitment TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('enrolled','reenrolled')), root_revision INTEGER NOT NULL, created_at INTEGER NOT NULL" },
  { name:'observer_revocations_v0', columns:'key_id,revoked_at', optional:true,
    schema:'key_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL' },
  { name:'observation_device_counters_v0', columns:'device_id,counter', optional:true,
    schema:'device_id TEXT PRIMARY KEY, counter INTEGER NOT NULL' },
] as const;

export function demoRuntimeDatabase(folder: string): string {
  return path.join(folder,'runtime-enrollment.sqlite');
}

/** One-time private snapshot import. Never resets an existing runtime or edits source. */
export async function importDemoEnrollment(sourceFile: string | undefined, destination: string, repo: string): Promise<void> {
  assert.ok(path.isAbsolute(destination),'Use an absolute runtime path');
  const parent=await externalFile(path.dirname(destination),repo);
  assert.equal(statSync(parent).mode&0o077,0,'Runtime directory must be private');
  const source = sourceFile ? new DatabaseSync(await privateFile(sourceFile,repo),{readOnly:true}) : undefined;
  let target: DatabaseSync | undefined;
  try {
    // Exclusive creation protects assertion counters on retries. Failed preparations
    // remain explicit failures; they cannot silently replace a partially imported DB.
    const fd=openSync(destination,'wx',0o600);closeSync(fd);
    target=new DatabaseSync(destination);
    source?.exec('BEGIN');target.exec('BEGIN IMMEDIATE');
    for (const table of TABLES) {
      target.exec(`CREATE TABLE ${table.name} (${table.schema})`);
      if (!source) continue; // fixture mode creates no synthetic Apple enrollment
      const exists=source.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table.name);
      if (!exists && 'optional' in table) continue;
      assert.equal(exists?.type,'table',`Unsupported enrollment input: missing ${table.name}`);
      const rows=source.prepare(`SELECT ${table.columns} FROM ${table.name}`).all();
      const columns=table.columns.split(',');
      const insert=target.prepare(`INSERT INTO ${table.name} (${table.columns}) VALUES (${columns.map(()=>'?').join(',')})`);
      for (const row of rows) insert.run(...columns.map(column=>row[column]!));
    }
    if(source) {
      assert.ok(target.prepare('SELECT key_id FROM observer_enrollments LIMIT 1').get(),'No verified enrollment to import');
      assert.equal(target.prepare(`SELECT COUNT(*) AS n FROM observer_enrollments e LEFT JOIN app_attest_keys k
        ON k.key_id=e.key_id WHERE k.key_id IS NULL`).get()!.n,0,'Missing enrolled App Attest key');
      assert.equal(target.prepare('SELECT COUNT(*) AS n FROM app_attest_keys WHERE counter<0 OR counter>4294967295').get()!.n,0,'Invalid assertion counter');
    }
    target.exec('COMMIT');
  } finally {
    if(target?.isTransaction)target.exec('ROLLBACK');target?.close();
    if(source?.isTransaction)source.exec('ROLLBACK');source?.close();
  }
}
