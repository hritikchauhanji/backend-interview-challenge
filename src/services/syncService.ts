import axios from 'axios';
import crypto from 'crypto';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';
import { CHALLENGE_CONSTRAINTS } from '../utils/challenge-constraints';

export class SyncService {
  private apiUrl: string;
  private BATCH_SIZE: number;

  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '10', 10);
  }

  async sync(): Promise<SyncResult> {
    const queue: SyncQueueItem[] = await this.db.getSyncQueue();

    if (!queue.length) {
      return { success: true, synced_items: 0, failed_items: 0, errors: [] };
    }

    // group items into batches
    const batches: SyncQueueItem[][] = [];
    for (let i = 0; i < queue.length; i += this.BATCH_SIZE) {
      batches.push(queue.slice(i, i + this.BATCH_SIZE));
    }

    let synced = 0;
    let failed = 0;
    const errors: any[] = [];

    for (const batch of batches) {
      try {
        const response = await this.processBatch(batch);

        for (const item of response.processed_items) {
          if (item.status === 'success') {
            synced++;
            await this.updateSyncStatus(item.client_id, 'synced', item.resolved_data);
          } else if (item.status === 'conflict' && item.resolved_data) {
            // Resolve conflicts locally
            await this.taskService.updateTask(item.resolved_data);
            await this.updateSyncStatus(item.client_id, 'synced', item.resolved_data);
            synced++;
          } else {
            failed++;
            errors.push({
              task_id: item.client_id,
              operation: 'unknown',
              error: item.error || 'Unknown error',
              timestamp: new Date(),
            });
            const failedItem = batch.find((b) => b.id === item.client_id);
            if (failedItem) {
              await this.handleSyncError(failedItem, new Error(item.error));
            }
          }
        }
      } catch (err: any) {
        // Entire batch failed
        for (const item of batch) {
          failed++;
          errors.push({
            task_id: item.task_id,
            operation: item.operation,
            error: err.message,
            timestamp: new Date(),
          });
          await this.handleSyncError(item, err);
        }
      }
    }

    return {
      success: failed === 0,
      synced_items: synced,
      failed_items: failed,
      errors,
    };
  }

  async addToSyncQueue(
    taskId: string,
    operation: 'create' | 'update' | 'delete',
    data: Partial<Task>
  ): Promise<void> {
    const item: SyncQueueItem = {
      id: crypto.randomUUID(),
      task_id: taskId,
      operation,
      data,
      created_at: new Date(),
      retry_count: 0,
    };
    await this.db.insertSyncQueueItem(item);
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    // sort per task chronologically
    items.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    const checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');

    const payload: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
    };

    const response = await axios.post<BatchSyncResponse>(
      `${this.apiUrl}/batch`,
      { ...payload, checksum }
    );

    return response.data;
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTime = new Date(localTask.updated_at).getTime();
    const serverTime = new Date(serverTask.updated_at).getTime();

    if (localTime > serverTime) {
      return localTask;
    } else if (serverTime > localTime) {
      return serverTask;
    } else {
      // timestamps equal → use delete > update > create
      const priority = CHALLENGE_CONSTRAINTS.CONFLICT_PRIORITY;
      return priority['delete']
        ? serverTask.is_deleted
          ? serverTask
          : localTask
        : localTask;
    }
  }

  private async updateSyncStatus(
    clientId: string,
    status: 'synced' | 'error',
    serverData?: Partial<Task>
  ): Promise<void> {
    const now = new Date();
    if (status === 'synced') {
      await this.db.removeFromSyncQueue(clientId);
    } else {
      await this.db.updateSyncQueueStatus(clientId, status);
    }

    if (serverData?.id) {
      await this.taskService.updateTask({
        ...serverData,
        sync_status: status,
        last_synced_at: now,
      } as Task);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    item.retry_count += 1;
    item.error_message = error.message;

    if (item.retry_count >= 3) {
      // move to dead letter queue
      await this.db.moveToDeadLetterQueue(item);
      await this.db.removeFromSyncQueue(item.id);
    } else {
      await this.db.updateSyncQueueItem(item);
    }
  }

  async updateTaskFromServer(serverTask: Partial<Task> & { id: string }): Promise<Task> {
    const existingTask = await this.taskService.getTask(serverTask.id);
    if (!existingTask) throw new Error('Task not found');

    const now = new Date();
    const updatedTask: Task = {
      ...existingTask,
      title: serverTask.title ?? existingTask.title,
      description: serverTask.description ?? existingTask.description,
      completed: serverTask.completed ?? existingTask.completed,
      sync_status: serverTask.sync_status ?? 'synced',
      server_id: serverTask.server_id ?? existingTask.server_id,
      last_synced_at: serverTask.last_synced_at ?? now,
      updated_at: now,
    };

    await this.db.run(
      `UPDATE tasks
     SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?, server_id = ?, last_synced_at = ?
     WHERE id = ?`,
      [
        updatedTask.title,
        updatedTask.description,
        updatedTask.completed ? 1 : 0,
        updatedTask.updated_at.toISOString(),
        updatedTask.sync_status,
        updatedTask.server_id,
        (updatedTask.last_synced_at ?? now).toISOString(),
        updatedTask.id,
      ]
    );

    return updatedTask;
  }


  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
