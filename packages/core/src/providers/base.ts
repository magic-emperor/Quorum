import type { AgentMessage, AgentResponse } from '../types.js'

export interface ProviderOptions {
  apiKey?: string
  baseUrl?: string
  model: string
}

export abstract class BaseProvider {
  protected model: string

  constructor(protected options: ProviderOptions) {
    this.model = options.model
  }

  abstract call(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens?: number
  ): Promise<AgentResponse>

  abstract isAvailable(): Promise<boolean>
}
