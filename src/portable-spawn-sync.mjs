import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';

function windowsPath(env) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
}

function pairedPowerShellShim(command) {
  const extension = extname(command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return null;
  const sibling = join(dirname(command), `${basename(command, extension)}.ps1`);
  return existsSync(sibling) ? sibling : null;
}

function resolveWindowsCommand(command, env) {
  const extension = extname(command).toLowerCase();
  if (isAbsolute(command) || command.includes('\\') || command.includes('/')) {
    return pairedPowerShellShim(command) ?? command;
  }
  for (const directory of windowsPath(env).split(delimiter).filter(Boolean)) {
    for (const suffix of ['.exe', '.ps1', '.cmd', '.bat', '']) {
      const candidate = join(directory, `${command}${suffix}`);
      if (!existsSync(candidate)) continue;
      return pairedPowerShellShim(candidate) ?? candidate;
    }
  }
  return command;
}

export function spawnPortableSync(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnOptions = { ...options };
  delete spawnOptions.platform;
  spawnOptions.shell = false;

  if (platform !== 'win32') return spawnSync(command, args, spawnOptions);

  const env = spawnOptions.env ?? process.env;
  const resolved = resolveWindowsCommand(command, env);
  const extension = extname(resolved).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(extension)) {
    return spawnSync(process.execPath, [resolved, ...args], spawnOptions);
  }
  if (extension === '.ps1') {
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolved,
      ...args,
    ], spawnOptions);
  }
  return spawnSync(resolved, args, spawnOptions);
}
