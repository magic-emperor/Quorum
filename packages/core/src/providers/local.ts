import type { AgentMessage, AgentResponse } from '../types.js'
import { BaseProvider } from './base.js'

interface OllamaResponse {
  message: { content: string }
  eval_count?: number
  prompt_eval_count?: number
}

export class OllamaProvider extends BaseProvider {
  private endpoint: string

  constructor(model: string, endpoint?: string) {
    super({ model })
    this.endpoint = endpoint ?? process.env['LOCAL_OLLAMA_ENDPOINT'] ?? 'http://localhost:11434'
  }

  async call(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens = 8192
  ): Promise<AgentResponse> {
    const allMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system')
    ]

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: allMessages,
        stream: false,
        options: { num_predict: maxTokens }
      })
    })

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as OllamaResponse

    return {
      content: data.message.content,
      usage: {
        input_tokens: data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0
      },
      model: this.model,
      provider: 'local'
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const endpoint = this.endpoint
      const response = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      })
      return response.ok
    } catch {
      return false
    }
  }
}
