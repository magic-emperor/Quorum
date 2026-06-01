/**
 * Qorum server client — HTTP + WebSocket.
 */
export interface QorumEvent {
    run_id: string;
    kind: string;
    agent: string;
    summary: string;
    ok: boolean;
    ts: string;
    path?: string;
    lines_added?: number;
    lines_removed?: number;
    reason?: string;
    payload?: Record<string, unknown>;
    exit_code?: number;
}

export class QorumClient {
    private ws: WebSocket | undefined;
    private _handlers: Array<(e: QorumEvent) => void> = [];
    private _connected = false;

    constructor(
        private readonly serverUrl: string,
        private readonly token: string,
    ) {}

    onEvent(handler: (e: QorumEvent) => void): void {
        this._handlers.push(handler);
    }

    async connect(runId: string): Promise<void> {
        const wsUrl = this.serverUrl
            .replace(/^http/, 'ws')
            .replace(/\/$/, '') + `/ws/runs/${runId}`;

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this._connected = true;
                resolve();
            };

            this.ws.onmessage = (msg) => {
                try {
                    const event: QorumEvent = JSON.parse(msg.data as string);
                    this._handlers.forEach(h => h(event));
                } catch { /* ignore malformed */ }
            };

            this.ws.onerror = (err) => {
                if (!this._connected) reject(err);
            };

            this.ws.onclose = () => {
                this._connected = false;
            };
        });
    }

    disconnect(): void {
        this.ws?.close();
        this._connected = false;
    }

    async getEvents(runId: string): Promise<QorumEvent[]> {
        const resp = await fetch(`${this.serverUrl}/runs/${runId}/events`, {
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        });
        return resp.ok ? resp.json() : [];
    }

    async getDiff(runId: string): Promise<{ diff: string; change_log: unknown[]; gate: unknown }> {
        const resp = await fetch(`${this.serverUrl}/runs/${runId}/diff`, {
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        });
        return resp.ok ? resp.json() : { diff: '', change_log: [], gate: null };
    }

    async approveDiff(): Promise<boolean> {
        if (!this.ws) return false;
        // Derive run_id from the active WS URL
        const runId = this.ws.url.split('/ws/runs/')[1];
        const resp = await fetch(`${this.serverUrl}/runs/${runId}/approve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            },
            body: JSON.stringify({ user: 'vscode-user' }),
        });
        return resp.ok;
    }

    async discard(): Promise<boolean> {
        if (!this.ws) return false;
        const runId = this.ws.url.split('/ws/runs/')[1];
        const resp = await fetch(`${this.serverUrl}/runs/${runId}/discard`, {
            method: 'POST',
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        });
        return resp.ok;
    }

    async stop(): Promise<boolean> {
        if (!this.ws) return false;
        const runId = this.ws.url.split('/ws/runs/')[1];
        const resp = await fetch(`${this.serverUrl}/runs/${runId}/stop`, {
            method: 'POST',
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        });
        return resp.ok;
    }
}
