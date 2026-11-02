import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFault } from '../agent-server/protocol.js';
import { parseArguments, tokenizeCommand } from './arguments.js';
import { readCommandInput } from './input.js';
import { Readable } from 'node:stream';

export async function editDraftText(text: string, options: { cwd: string; signal?: AbortSignal; command?: string; retention: string }): Promise<string> {
    if (options.retention === 'temporary') throw new AgentFault('E_TEMPORARY_EDITOR_UNAVAILABLE', '临时会话使用内置多行编辑，外部编辑器需要先转换保存方式');
    if (!['archive', 'ttl'].includes(options.retention)) throw new AgentFault('E_EDITOR_FAILED', '先打开归档或限时会话，再使用外部编辑器');
    const configured = options.command ?? process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad.exe' : '');
    const command = tokenizeCommand(configured);
    if (!command.length) throw new AgentFault('E_EDITOR_FAILED', '尚未配置VISUAL或EDITOR');
    const directory = await fs.mkdtemp(join(tmpdir(), 'sandbox-agent-editor-'));
    const path = join(directory, 'draft.txt');
    try {
        await fs.writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await new Promise<void>((resolveEditor, rejectEditor) => {
            const child = spawn(command[0], [...command.slice(1), path], { cwd: options.cwd, stdio: 'inherit', shell: false, signal: options.signal });
            let launchError: Error | undefined;
            child.once('error', error => { launchError = error; });
            child.once('close', (code, signal) => code === 0 && !launchError ? resolveEditor() : rejectEditor(launchError ?? new Error(`编辑器退出：${code ?? signal ?? '未知'}`)));
        });
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('编辑器返回的对象不是本次草稿文件');
        return (await readCommandInput(parseArguments(['--input-file', path]), Readable.from([]))) ?? text;
    } catch (error) { throw new AgentFault('E_EDITOR_FAILED', '外部编辑未完成，原草稿保留', { reason: error instanceof Error ? error.message : String(error) }); }
    finally { await fs.unlink(path).catch(() => {}); await fs.rmdir(directory).catch(() => {}); }
}
