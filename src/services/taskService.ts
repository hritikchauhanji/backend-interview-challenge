import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) { }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id || null,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
    };
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const now = new Date();

    const task: Task = {
      id,
      title: taskData.title || 'Untitled Task',
      description: taskData.description || '',
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: null,
      last_synced_at: null,
    };

    await this.db.run(
      `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status,  server_id, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.title,
        task.description,
        task.completed ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
        0,
        'pending',
        null,
        null,
      ]
    );

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)`,
      [uuidv4(), task.id, 'create', JSON.stringify(task)]
    );

    return task;
  }

  async updateTask(taskData: Partial<Task> & { id: string }): Promise<Task> {
    const existingTask = await this.getTask(taskData.id);
    if (!existingTask) throw new Error('Task not found');

    const now = new Date();
    const updatedTask: Task = {
      ...existingTask,
      title: taskData.title ?? existingTask.title,
      description: taskData.description ?? existingTask.description,
      completed: taskData.completed ?? existingTask.completed,
      updated_at: now,
      sync_status: 'pending', // always pending until sync
      server_id: existingTask.server_id,
      last_synced_at: existingTask.last_synced_at,
    };

    await this.db.run(
      `UPDATE tasks
     SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
     WHERE id = ?`,
      [
        updatedTask.title,
        updatedTask.description,
        updatedTask.completed ? 1 : 0,
        now.toISOString(),
        updatedTask.sync_status,
        updatedTask.id,
      ]
    );

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)`,
      [uuidv4(), updatedTask.id, 'update', JSON.stringify(updatedTask)]
    );

    return updatedTask;
  }


  async deleteTask(id: string): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;

    const now = new Date();

    await this.db.run(
      `UPDATE tasks
       SET is_deleted = 1, updated_at = ?, sync_status = ?
       WHERE id = ?`,
      [now.toISOString(), 'pending', id]
    );

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)`,
      [
        uuidv4(),
        id,
        'delete',
        JSON.stringify({ ...task, is_deleted: true, updated_at: now }),
      ]
    );

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!row || row.is_deleted) return null;
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(`SELECT * FROM tasks WHERE is_deleted = 0`);
    return rows.map((row: any) => this.mapRowToTask(row));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all(
      `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error')`
    );
    return rows.map((row: any) => this.mapRowToTask(row));
  }

}
