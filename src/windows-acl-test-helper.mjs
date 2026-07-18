import { spawnSync } from 'node:child_process';

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
if($isDir){[System.IO.Directory]::SetAccessControl($target,$acl)}else{[System.IO.File]::SetAccessControl($target,$acl)}
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
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
$acl=if($isDir){[System.IO.Directory]::GetAccessControl($target)}else{[System.IO.File]::GetAccessControl($target)}
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid){exit 41}
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 1){exit 42}
$rule=$rules[0]
if($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      THROUGHLINE_TEST_ACL_PATH: path,
      THROUGHLINE_TEST_ACL_DIRECTORY: directory ? '1' : '0',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Windows ACL fixture verification failed');
}
