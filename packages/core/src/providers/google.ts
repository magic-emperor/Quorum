import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AgentMessage, AgentResponse } from '../types.js'
import { BaseProvider, type ProviderOptions } from './base.js'

export class GoogleProvider extends BaseProvider {
  private client: GoogleGenerativeAI

  constructor(options: ProviderOptions) {
    super(options)
    const apiKey = options.apiKey ?? process.env['GOOGLE_AI_API_KEY'] ?? ''
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async call(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens = 8192
  ): Promise<AgentResponse> {
    const genModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
      generationConfig: { maxOutputTokens: maxTokens }
    })

    const filtered = messages.filter(m => m.role !== 'system')

    const history = filtered.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))

    const lastMessage = filtered.at(-1)

    const chat = genModel.startChat({ history })
    const result = await chat.sendMessage(lastMessage?.content ?? '')
    const content = result.response.text()

    return {
      content,
      usage: {
        input_tokens: result.response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: result.response.usageMetadata?.candidatesTokenCount ?? 0
      },
      model: this.model,
      provider: 'google'
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.options.apiKey ?? process.env['GOOGLE_AI_API_KEY'])
  }
}
