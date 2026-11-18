import type { Config } from './config.ts';

export type TaskClass = 'default' | 'web_execution' | 'planning_analysis';
export type TaskMetadata = { task?: TaskClass; phase?: Exclude<TaskClass, 'default'> };

export function selectModel(config: Config, mode: TaskClass | 'auto', metadata: TaskMetadata = {}): { task: TaskClass; model: string } {
  const task = mode === 'auto' ? metadata.phase ?? metadata.task ?? 'default' : mode;
  if (!['default', 'web_execution', 'planning_analysis'].includes(task)) throw new Error('Invalid task classification');
  return { task, model: (task === 'web_execution' ? config.webModel : task === 'planning_analysis' ? config.analysisModel : undefined) || config.model };
}
