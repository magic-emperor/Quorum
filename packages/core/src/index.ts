// Public API for @atlas/core
export { ATLASEngine } from './engine.js'
export { NervousSystem } from './memory/nervous-system.js'
export { AgentRunner } from './agent-runner.js'
export { ToolExecutor } from './tool-executor.js'
export { buildProvider, detectAvailableProviders, buildRoutingTable } from './providers/index.js'
export { discoverProviderModels, envVarToProvider, providerToEnvVar } from './providers/index.js'
export type { DiscoveryResult, DiscoveredTiers } from './providers/index.js'
export type {
  ATLASConfig,
  ATLASRunOptions,
  RoutingTable,
  ResolvedModel,
  AgentMessage,
  AgentResponse,
  ToolCall,
  ToolResult,
  Checkpoint,
  ProjectMemory,
  Decision,
  Action,
  OpenQuestion,
  TechStack,
  Bug,
  FunctionEntry,
  ClassificationResult,
  ProjectComplexity
} from './types.js'
