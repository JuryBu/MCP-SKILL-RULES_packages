import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export interface FolderPickerOptions {
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
}

export class FolderPickerError extends Error {
    constructor(message: string, readonly details: { phase: 'launch' | 'output' | 'exit'; exitCode: number | null;
        signal: string | null; stderr: string; outputBytes: number }) {
        super(message); this.name = 'FolderPickerError';
    }
}

export async function pickDirectory(initialPath: string, options: FolderPickerOptions = {}): Promise<string | undefined> {
    if ((options.platform ?? process.platform) !== 'win32') throw new Error('当前系统请使用终端内目录浏览或路径补全');
    const script = [
        "$ErrorActionPreference='Stop'",
        '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog=New-Object System.Windows.Forms.FolderBrowserDialog',
        "try{$dialog.Description='选择工作目录'",
        '$dialog.SelectedPath=$env:SANDBOX_AGENT_PICKER_PATH',
        '$dialog.ShowNewFolderButton=$true',
        'if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.SelectedPath)}}finally{$dialog.Dispose()}',
    ].join(';');
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = (options.spawnProcess ?? spawn)(executable, ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', script], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal,
        env: { ...process.env, SANDBOX_AGENT_PICKER_PATH: resolve(initialPath) },
    });
    return new Promise<string | undefined>((resolveSelection, rejectSelection) => {
        let output = '';
        let stderr = '';
        let launchError: Error | undefined;
        let outputExceeded = false;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            output += chunk;
            if (Buffer.byteLength(output, 'utf8') > 64 * 1024) { outputExceeded = true; output = ''; child.kill(); }
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { stderr = Buffer.from(stderr + chunk, 'utf8').subarray(-8192).toString('utf8'); });
        child.once('error', (error: Error) => { launchError = error; });
        child.once('close', (code, signal) => {
            if (options.signal?.aborted) { resolveSelection(undefined); return; }
            if (launchError || outputExceeded || code !== 0) {
                rejectSelection(new FolderPickerError(outputExceeded ? '系统选择器返回的路径过长，原选择已保留'
                    : launchError ? '系统文件夹选择器未能启动' : '系统文件夹选择器已退出，未返回目录', {
                    phase: launchError ? 'launch' : outputExceeded ? 'output' : 'exit', exitCode: code, signal: signal ?? null,
                    stderr: stderr || launchError?.message || '', outputBytes: Buffer.byteLength(output, 'utf8'),
                })); return;
            }
            const path = output.replace(/^\uFEFF/, '').trim();
            resolveSelection(path ? resolve(path) : undefined);
        });
    });
}
