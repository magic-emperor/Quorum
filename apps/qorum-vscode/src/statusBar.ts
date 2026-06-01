import * as vscode from 'vscode';
import { QorumEvent } from './client';

export class StatusBar {
    private _item: vscode.StatusBarItem;
    private _buildOk: boolean | null = null;
    private _testsPassed = 0;
    private _testsTotal = 0;
    private _currentFile = '';

    constructor() {
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._item.command = 'qorum.showDashboard';
        this._item.show();
    }

    update(state: 'idle' | 'connecting' | 'running' | 'approved' | 'discarded'): void {
        const icons: Record<string, string> = {
            idle: '$(circle-outline)',
            connecting: '$(sync~spin)',
            running: '$(loading~spin)',
            approved: '$(check)',
            discarded: '$(x)',
        };
        this._item.text = `${icons[state] || '$(circle-outline)'} Qorum: ${state}`;
        this._item.backgroundColor = state === 'approved'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
    }

    handleEvent(event: QorumEvent): void {
        if (event.kind === 'fs_edit' || event.kind === 'fs_write' || event.kind === 'file_edit') {
            this._currentFile = event.path ? event.path.split('/').pop() || '' : '';
        }
        if (event.kind === 'build' || event.kind === 'gate_build') {
            this._buildOk = event.ok;
        }
        if (event.kind === 'test_result' || event.kind === 'gate_test') {
            if (event.ok) {
                this._testsPassed++;
                this._testsTotal++;
            } else {
                this._testsTotal++;
            }
        }

        const parts: string[] = ['$(loading~spin) Qorum'];
        if (this._currentFile) parts.push(`editing ${this._currentFile}…`);
        if (this._buildOk !== null) parts.push(`build ${this._buildOk ? '✓' : '✗'}`);
        if (this._testsTotal > 0) parts.push(`tests ${this._testsPassed}/${this._testsTotal}`);
        this._item.text = parts.join(' · ');
    }

    dispose(): void {
        this._item.dispose();
    }
}
