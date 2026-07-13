import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

const WINDOWS_COMMAND_ENV = 'THROUGHLINE_WINDOWS_CHILD_COMMAND';
const WINDOWS_ARGS_ENV = 'THROUGHLINE_WINDOWS_CHILD_ARGS_B64';
const WINDOWS_LAUNCHER = String.raw`
$ErrorActionPreference='Stop'
$command=$env:THROUGHLINE_WINDOWS_CHILD_COMMAND
$encoded=$env:THROUGHLINE_WINDOWS_CHILD_ARGS_B64
$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
$childArgs=@(ConvertFrom-Json -InputObject $json)
Remove-Item Env:THROUGHLINE_WINDOWS_CHILD_COMMAND -ErrorAction SilentlyContinue
Remove-Item Env:THROUGHLINE_WINDOWS_CHILD_ARGS_B64 -ErrorAction SilentlyContinue
& $command @childArgs
if($null -eq $LASTEXITCODE){exit 0}
exit $LASTEXITCODE
`;

export function spawnPortableSync(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnOptions = { ...options };
  delete spawnOptions.platform;
  spawnOptions.shell = false;

  if (platform !== 'win32') return spawnSync(command, args, spawnOptions);

  const extension = extname(command).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(extension)) {
    return spawnSync(process.execPath, [command, ...args], spawnOptions);
  }
  if (extension === '.exe' || (isAbsolute(command) && !existsSync(command))) {
    return spawnSync(command, args, spawnOptions);
  }

  const env = {
    ...(spawnOptions.env ?? process.env),
    [WINDOWS_COMMAND_ENV]: command,
    [WINDOWS_ARGS_ENV]: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
  };
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_LAUNCHER],
    { ...spawnOptions, env },
  );
}
