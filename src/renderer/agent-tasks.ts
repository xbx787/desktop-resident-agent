import type { TimelineEntry } from '../shared/contracts'

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  subject: string
  status: AgentTaskStatus
}

const STATUSES = new Set<string>(['pending', 'in_progress', 'completed'])

function normalizeStatus(value: unknown): AgentTaskStatus | null {
  return typeof value === 'string' && STATUSES.has(value) ? value as AgentTaskStatus : null
}

function parseObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Task ids arrive as "12" in TaskUpdate, but the create result says "Task #12". */
function taskId(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/^#/u, '') : ''
}

/**
 * The agent's task list as it stands at the end of a conversation: TaskCreate
 * adds, TaskUpdate moves or removes, TodoWrite replaces the whole list. Derived
 * from the conversation itself, so a reloaded conversation shows the same list.
 */
export function agentTasks(entries: readonly TimelineEntry[]): AgentTask[] {
  const tasks: AgentTask[] = []
  for (const entry of entries) {
    const tool = entry.tool
    if (!tool || tool.status === 'running') continue; // A running call has no result to trust yet.
    const name = tool.name.trim().toLowerCase()
    if (name !== 'todowrite' && name !== 'taskcreate' && name !== 'taskupdate') continue;
    const input = parseObject(tool.input)
    if (!input) continue;
    if (name === 'todowrite') {
      // TodoWrite always sends the complete list, so it replaces whatever we had.
      if (!Array.isArray(input.todos)) continue;
      const next: AgentTask[] = [];
      input.todos.forEach((item, index) => {
        const todo = item && typeof item === 'object' ? item as Record<string, unknown> : null;
        const subject = typeof todo?.content === 'string' ? todo.content.trim() : '';
        const status = normalizeStatus(todo?.status);
        if (subject && status) next.push({ id: `todo-${index}`, subject, status });
      });
      tasks.length = 0;
      tasks.push(...next);
      continue;
    }
    if (name === 'taskcreate') {
      const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
      if (!subject) continue;
      const created = /task\s*#?\s*(\d+)/iu.exec(tool.output ?? '');
      const id = created ? created[1] : `new-${tasks.length}`;
      // The CLI numbers its tasks per process and restarts at #1 whenever the
      // process does, so a number that is not above everything we hold means a
      // new list has begun and the previous one is gone. Keeping both would
      // strand the strip on long-finished tasks and swallow this turn's plan.
      const highest = tasks.reduce((max, task) => (/^\d+$/u.test(task.id) ? Math.max(max, Number(task.id)) : max), 0);
      if (/^\d+$/u.test(id) && Number(id) <= highest) tasks.length = 0;
      tasks.push({ id, subject, status: 'pending' });
      continue;
    }
    const id = taskId(input.taskId);
    const index = id ? tasks.findIndex((task) => task.id === id) : -1;
    if (index < 0) continue;
    if (input.status === 'deleted') { tasks.splice(index, 1); continue; }
    const status = normalizeStatus(input.status);
    const subject = typeof input.subject === 'string' && input.subject.trim() ? input.subject.trim() : '';
    if (!status && !subject) continue;
    tasks[index] = { ...tasks[index], ...(status ? { status } : {}), ...(subject ? { subject } : {}) };
  }
  return tasks
}
