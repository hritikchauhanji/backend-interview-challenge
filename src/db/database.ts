import sqlite3 from 'sqlite3';
import { Task, SyncQueueItem } from '../types';

const sqlite = sqlite3.verbose();

export class Database {
  private db: sqlite3.Database;

  constructor(filename: string = ':memory:') {
    this.db = new sqlite.Database(filename);
  }

  async initialize(): Promise<void> {
    await this.createTables();
  }

  private async createTables(): Promise<void> {
    const createTasksTable = `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_deleted INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        server_id TEXT,
        last_synced_at DATETIME
      )
    `;

    const createSyncQueueTable = `
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `;

    const createDeadLetterTable = `
      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME,
        retry_count INTEGER,
        error_message TEXT,
        moved_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await this.run(createTasksTable);
    await this.run(createSyncQueueTable);
    await this.run(createDeadLetterTable);
  }

  // --------------------
  // Generic helpers
  // --------------------
  run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // --------------------
  // Sync Queue methods
  // --------------------
  async getSyncQueue(): Promise<SyncQueueItem[]> {
    const rows = await this.all(`SELECT * FROM sync_queue ORDER BY created_at ASC`);
    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data),
      created_at: new Date(row.created_at),
    }));
  }

  async insertSyncQueueItem(item: SyncQueueItem): Promise<void> {
    await this.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.task_id,
        item.operation,
        JSON.stringify(item.data),
        item.created_at.toISOString(),
        item.retry_count,
        item.error_message || null,
      ]
    );
  }

  async updateSyncQueueItem(item: SyncQueueItem): Promise<void> {
    await this.run(
      `UPDATE sync_queue
       SET retry_count = ?, error_message = ?
       WHERE id = ?`,
      [item.retry_count, item.error_message, item.id]
    );
  }

  async updateSyncQueueStatus(id: string, status: string): Promise<void> {
    await this.run(
      `UPDATE sync_queue SET error_message = ? WHERE id = ?`,
      [status, id]
    );
  }

  async removeFromSyncQueue(id: string): Promise<void> {
    await this.run(`DELETE FROM sync_queue WHERE id = ?`, [id]);
  }

  // --------------------
  // Dead Letter Queue
  // --------------------
  async moveToDeadLetterQueue(item: SyncQueueItem): Promise<void> {
    await this.run(
      `INSERT INTO dead_letter_queue (id, task_id, operation, data, created_at, retry_count, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.task_id,
        item.operation,
        JSON.stringify(item.data),
        item.created_at.toISOString(),
        item.retry_count,
        item.error_message || null,
      ]
    );
  }

  async getDeadLetterQueue(): Promise<SyncQueueItem[]> {
    const rows = await this.all(`SELECT * FROM dead_letter_queue ORDER BY moved_at DESC`);
    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data),
      created_at: new Date(row.created_at),
    }));
  }

  // --------------------
  // Sync status helpers
  // --------------------
  async countPendingSyncItems(): Promise<number> {
    const row = await this.get(`SELECT COUNT(*) as count FROM sync_queue`);
    return row?.count || 0;
  }

  async getLastSyncTimestamp(): Promise<Date | null> {
    const row = await this.get(`SELECT MAX(last_synced_at) as lastSync FROM tasks`);
    return row?.lastSync ? new Date(row.lastSync) : null;
  }

}
