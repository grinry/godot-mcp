import { authoringTools } from './authoring-tools.js';
import { configurationTools } from './configuration-tools.js';
import { legacyTools } from './legacy-tools.js';
import { playtestTools } from './playtest-tools.js';
import { overviewTool } from './project-overview.js';
import { resourceTools } from './resource-tools.js';
import { runtimeTools } from './runtime-tools.js';
import { samplingTools } from './sampling-tools.js';
import { sceneTools } from './scene-tools.js';
import { extraTools } from './workflow-tools.js';

/** Policy fallback and registry parity use the same metadata as discovery. */
export const toolSpecifications = [
  ...legacyTools,
  ...authoringTools,
  ...configurationTools,
  ...resourceTools,
  ...playtestTools,
  ...sceneTools,
  ...runtimeTools,
  ...samplingTools,
  ...extraTools,
  overviewTool,
];
