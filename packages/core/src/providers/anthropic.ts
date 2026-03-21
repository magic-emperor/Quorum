import Anthropic from '@anthropic-ai/sdk'
import type { AgentMessage, AgentResponse } from '../types.js'
import { BaseProvider, type ProviderOptions } from './base.js'

export class AnthropicProvider extends BaseProvider {
  private client: Anthropic

  constructor(options: ProviderOptions) {
    super(options)
    this.client = new Anthropic({
      apiKey: options.apiKey ?? process.env['ANTHROPIC_API_KEY'],
      baseURL: options.baseUrl
    })
  }

  async call(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens = 8192
  ): Promise<AgentResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        }))
    })

    const content = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    return {
      content,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      },
      model: this.model,
      provider: 'anthropic'
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.options.apiKey ?? process.env['ANTHROPIC_API_KEY'])
  }
}
