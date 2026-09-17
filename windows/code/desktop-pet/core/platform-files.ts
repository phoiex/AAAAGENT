import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** relative() can return a drive-qualified path when Windows volumes differ. */
export function isOutside(parent: string, target: string): boolean {
  const part = relative(resolve(parent), resolve(target));
  return part === '..' || part.startsWith('..' + sep) || isAbsolute(part);
}

// Pass paths as environment data, never PowerShell source or shell interpolation.
const aclScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\\Modules'
$p = $env:AAAAGENT_ACL_PATH
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid.Value) {
  # An elevated Windows token can create files owned by Administrators rather
  # than by TokenUser. Only the explicit restrict operation may normalize that
  # exact default owner; read-only checks and other owners remain rejected.
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($env:AAAAGENT_ACL_ACTION -ne 'restrict' -or
      $owner -ne 'S-1-5-32-544' -or $owner -ne $identity.Owner.Value -or
      -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 2 }
}
if ($env:AAAAGENT_ACL_ACTION -eq 'restrict') {
  $item = Get-Item -LiteralPath $p -Force
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  if ($owner -ne $sid.Value) { $acl.SetOwner($sid) }
  $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($id in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [Security.Principal.SecurityIdentifier]::new($id)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
  $acl = Get-Acl -LiteralPath $p
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { exit 3 }
}
exit 0
`;
function windowsAcl(filename: string, action: 'check' | 'restrict'): void {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try { execFileSync(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, stdio: 'pipe', env: { ...process.env, AAAAGENT_ACL_PATH: resolve(filename), AAAAGENT_ACL_ACTION: action } }); }
  catch (error) {
    // Expose only fixed failure categories, never subprocess output, paths or file contents.
    const failure = error as { status?: number; code?: string };
    const reason = failure.status === 2 ? 'owner_mismatch'
      : failure.status === 3 ? 'broad_access'
      : failure.code === 'ETIMEDOUT' ? 'timeout' : 'powershell_failure';
    throw Error(`Windows could not verify or restrict this owned file (${reason}). Check its owner and access permissions.`);
  }
}
/** Metadata only. No credential contents are read. Windows checks SID-based DACLs. */
export function isPrivateFileSync(filename: string, opened?: Stats): boolean {
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || opened && (info.dev !== opened.dev || info.ino !== opened.ino)) return false;
    if (process.platform === 'win32') windowsAcl(filename, 'check');
    else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return false;
    return true;
  } catch { return false; }
}
/** Use only for files/directories created by this application or explicitly selected by the user. */
export function restrictPrivatePathSync(filename: string): void {
  const info = lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('Expected an ordinary owned path');
  if (process.platform === 'win32') windowsAcl(filename, 'restrict');
  else chmodSync(filename, info.isDirectory() ? 0o700 : 0o600);
}
