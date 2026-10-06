import { authoringTools } from './authoring-tools.js';
import { legacyTools } from './legacy-tools.js';
import { overviewTool } from './project-overview.js';
import { runtimeTools } from './runtime-tools.js';
import { sceneTools } from './scene-tools.js';
import { extraTools } from './workflow-tools.js';

/** Policy fallback and registry parity use the same metadata as discovery. */
export const toolSpecifications = [
  ...legacyTools,
  ...authoringTools,
  ...sceneTools,
  ...runtimeTools,
  ...extraTools,
  overviewTool,
];
