// Public API for @atlas/core
export { ATLASEngine } from './engine.js'
export { NervousSystem } from './memory/nervous-system.js'
export { AgentRunner } from './agent-runner.js'
export { ToolExecutor } from './tool-executor.js'
export { buildProvider, detectAvailableProviders, buildRoutingTable } from './providers/index.js'
export { discoverProviderModels, envVarToProvider, providerToEnvVar } from './providers/index.js'
export type { DiscoveryResult, DiscoveredTiers } from './providers/index.js'

// Phase 3 command handlers (for CLI to import directly by name)
export {
  runInit, runFast, runNext, runPause, runResume,
  runDoctor, runDiscuss, runVerify, runShip, runReview,
  runMap, runDebug, runSessionReport, runSeed, runBacklog, runNote,
  runAgents, runProfile
} from './commands/index.js'

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
  ProjectComplexity,
  // Phase 3 result types
  DoctorReport,
  DoctorCheck,
  DiscussResult,
  VerifyResult,
  VerifyItem,
  SessionReport,
  HandoffState,
  AgentInfo,
  MapResult,
  Seed,
  BacklogItem,
  MilestoneState
} from './types.js'
