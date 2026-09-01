import { spawnSync } from 'node:child_process';

// GitHub hosted Windows runners can spend more than 15 seconds starting the
// inbox Windows PowerShell process while the Node matrix is contended. This is
// a hang guard for a fixture boundary, not a latency assertion.
const WINDOWS_ACL_FIXTURE_TIMEOUT_MS = 30_000;

export function applyWindowsPrivateAcl(path, directory = false) {
  if (process.platform !== 'win32') return;
  const script = String.raw`
$ErrorActionPreference='Stop'
$target=$env:THROUGHLINE_TEST_ACL_PATH; $isDir=$env:THROUGHLINE_TEST_ACL_DIRECTORY -eq '1'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=if($isDir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$inherit=if($isDir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
`;
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: WINDOWS_ACL_FIXTURE_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      THROUGHLINE_TEST_ACL_PATH: path,
      THROUGHLINE_TEST_ACL_DIRECTORY: directory ? '1' : '0',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Windows ACL fixture setup failed');
}

export function verifyWindowsPrivateAcl(path, directory = false) {
  if (process.platform !== 'win32') return;
  const script = String.raw`
$ErrorActionPreference='Stop'
$target=$env:THROUGHLINE_TEST_ACL_PATH; $isDir=$env:THROUGHLINE_TEST_ACL_DIRECTORY -eq '1'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath $target
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid){exit 41}
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 1){exit 42}
$rule=$rules[0]
if($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}
`;
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: WINDOWS_ACL_FIXTURE_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      THROUGHLINE_TEST_ACL_PATH: path,
      THROUGHLINE_TEST_ACL_DIRECTORY: directory ? '1' : '0',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Windows ACL fixture verification failed');
}
