import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch tasks",
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({
          error: "Task not found",
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch task",
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { title, description } = req.body;
      if (!title || typeof title !== "string") {
        return res.status(400).json({
          error: "Title is required and must be a string",
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }

      const task = await taskService.createTask({
        title,
        description: description || "",
      });

      res.status(201).json(task);
    } catch (error) {
      res.status(500).json({
        error: "Failed to create task",
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { title, description, completed } = req.body;

      if (title && typeof title !== "string") {
        return res.status(400).json({
          error: "Title must be a string",
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }

      const existingTask = await taskService.getTask(req.params.id);
      if (!existingTask) {
        return res.status(404).json({
          error: "Task not found",
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }

      const updatedTask = await taskService.updateTask({
        ...existingTask,
        title: title ?? existingTask.title,
        description: description ?? existingTask.description,
        completed: completed ?? existingTask.completed,
      });

      res.json(updatedTask);
    } catch (error) {
      res.status(500).json({
        error: "Failed to update task",
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });


  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const deleted = await taskService.deleteTask(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          error: "Task not found",
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({
        error: "Failed to delete task",
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });


  return router;
}