import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const connected = await syncService.checkConnectivity();
      if (!connected) {
        return res.status(503).json({ error: 'Server not reachable' });
      }
      const result = await syncService.sync();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check sync status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const pending = await db.countPendingSyncItems();
      const lastSync = await db.getLastSyncTimestamp();
      const connected = await syncService.checkConnectivity();
      const sync_queue_size = await db.countPendingSyncItems();

      res.json({
        pending,
        lastSync,
        connected,
        sync_queue_size,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Batch sync endpoint (server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      const { items, checksum } = req.body;
      console.log('Request Body:', req.body);
      if (!items) return res.status(400).json({ error: 'Items are required' });

      const recalculated = require('crypto')
        .createHash('sha256')
        .update(JSON.stringify(items))
        .digest('hex');

      if (checksum !== recalculated) {
        return res.status(400).json({ error: 'Checksum mismatch' });
      }

      const processed_items = [];

      for (const item of items) {
        // Update the task in DB
        const task = await taskService.getTask(item.task_id);
        if (!task) continue;

        const updatedTask = {
          ...task,
          server_id: `srv_${item.task_id}`, // or generate a real server ID
          last_synced_at: new Date(),
          sync_status: 'synced',
          title: item.data.title ?? task.title,
          description: item.data.description ?? task.description,
          completed: item.data.completed ?? task.completed,
        };

        await db.run(
          `UPDATE tasks SET
          title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?, server_id = ?, last_synced_at = ?
         WHERE id = ?`,
          [
            updatedTask.title,
            updatedTask.description,
            updatedTask.completed ? 1 : 0,
            new Date().toISOString(),
            updatedTask.sync_status,
            updatedTask.server_id,
            updatedTask.last_synced_at.toISOString(),
            updatedTask.id,
          ]
        );

        processed_items.push({
          client_id: item.id,
          server_id: updatedTask.server_id,
          status: 'success',
          resolved_data: updatedTask,
        });
      }

      res.json({ processed_items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // Health check endpoint
  router.get('/health', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}
