import { execFile } from 'node:child_process';
import { promisify } from 'util';
import { WORKSPACE_ROOT } from './pathSecurity.js';

const execFileAsync = promisify(execFile);

export const SAFE_COMMANDS = {
  'node-version': {
    executable: process.execPath,
    args: ['-e', 'console.log(process.version)']
  },
  'npm-version': {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['-v']
  },
  'dir-list': {
    executable: process.platform === 'win32' ? 'cmd.exe' : 'ls',
    args: process.platform === 'win32' ? ['/c', 'dir'] : ['-la']
  },
  'git-status': {
    executable: 'git',
    args: ['status', '--short']
  },
  'git-diff': {
    executable: 'git',
    args: ['diff', '--stat']
  }
};

export async function runSafeCommand(commandId) {
  const cmdConfig = SAFE_COMMANDS[commandId];
  if (!cmdConfig) {
    throw new Error(`Команда "${commandId}" не разрешена в белом списке.`);
  }

  return execFileAsync(cmdConfig.executable, cmdConfig.args, {
    cwd: WORKSPACE_ROOT,
    timeout: 60_000,
    windowsHide: true
  });
}