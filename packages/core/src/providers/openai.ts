import OpenAI from 'openai'
import type { AgentMessage, AgentResponse } from '../types.js'
import { BaseProvider, type ProviderOptions } from './base.js'

export class OpenAIProvider extends BaseProvider {
  protected client: OpenAI

  constructor(options: ProviderOptions) {
    super(options)
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: options.baseUrl
    })
  }

  async call(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens = 8192
  ): Promise<AgentResponse> {
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    ]

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: allMessages
    })

    const content = response.choices[0]?.message?.content ?? ''

    return {
      content,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0
      },
      model: this.model,
      provider: 'openai'
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.options.apiKey ?? process.env['OPENAI_API_KEY'])
  }
}

// Groq is OpenAI-compatible — reuse OpenAIProvider with different base URL
export class GroqProvider extends OpenAIProvider {
  constructor(apiKey?: string, model = 'llama-3.3-70b-versatile') {
    super({
      apiKey: apiKey ?? process.env['GROQ_API_KEY'],
      baseUrl: 'https://api.groq.com/openai/v1',
      model
    })
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.options.apiKey ?? process.env['GROQ_API_KEY'])
  }

  async call(messages: AgentMessage[], systemPrompt: string, maxTokens = 8192): Promise<AgentResponse> {
    const result = await super.call(messages, systemPrompt, maxTokens)
    return { ...result, provider: 'groq' }
  }
}

// DeepSeek is OpenAI-compatible
export class DeepSeekProvider extends OpenAIProvider {
  constructor(apiKey?: string, model = 'deepseek-chat') {
    super({
      apiKey: apiKey ?? process.env['DEEPSEEK_API_KEY'],
      baseUrl: 'https://api.deepseek.com/v1',
      model
    })
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.options.apiKey ?? process.env['DEEPSEEK_API_KEY'])
  }

  async call(messages: AgentMessage[], systemPrompt: string, maxTokens = 8192): Promise<AgentResponse> {
    const result = await super.call(messages, systemPrompt, maxTokens)
    return { ...result, provider: 'deepseek' }
  }
}
