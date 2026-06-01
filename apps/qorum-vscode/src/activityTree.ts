/**
 * Activity tree — shows changed files grouped by agent, live-updating.
 */
import * as vscode from 'vscode';
import { QorumEvent } from './client';

export class ActivityNode extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly kind: 'agent' | 'file' | 'event',
        public readonly path?: string,
        collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    ) {
        super(label, collapsible);
        this.contextValue = kind;
        if (kind === 'file' && path) {
            this.command = {
                command: 'vscode.open',
                title: 'Open file',
                arguments: [vscode.Uri.file(path)],
            };
            this.iconPath = new vscode.ThemeIcon('file-code');
        } else if (kind === 'agent') {
            this.iconPath = new vscode.ThemeIcon('robot');
        }
    }
}

export class QorumActivityProvider implements vscode.TreeDataProvider<ActivityNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActivityNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // agent → list of nodes
    private _agents: Map<string, ActivityNode[]> = new Map();
    private _agentOrder: string[] = [];

    addEvent(event: QorumEvent): void {
        if (event.kind === 'ping') return;

        const agent = event.agent || 'system';
        if (!this._agents.has(agent)) {
            this._agents.set(agent, []);
            this._agentOrder.push(agent);
        }

        const label = event.path
            ? `${event.kind}: ${event.path} ${event.lines_added ? `+${event.lines_added}` : ''}${event.lines_removed ? `/-${event.lines_removed}` : ''}`
            : event.summary;

        const node = new ActivityNode(label, event.path ? 'file' : 'event', event.path);
        node.description = event.reason || '';
        node.tooltip = event.summary;
        if (!event.ok) {
            node.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        }

        this._agents.get(agent)!.push(node);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ActivityNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ActivityNode): ActivityNode[] {
        if (!element) {
            // Root: one node per agent
            return this._agentOrder.map(agent => {
                const node = new ActivityNode(
                    agent,
                    'agent',
                    undefined,
                    vscode.TreeItemCollapsibleState.Expanded,
                );
                node.description = `${this._agents.get(agent)!.length} actions`;
                return node;
            });
        }
        // Children: events for this agent
        if (element.kind === 'agent') {
            return this._agents.get(element.label as string) || [];
        }
        return [];
    }
}
