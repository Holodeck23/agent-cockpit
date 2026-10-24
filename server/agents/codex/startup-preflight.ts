import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'

const MANAGED = 'This managed Codex setup is not supported by Cockpit yet. Your message was not delivered.'
const UNKNOWN = 'Codex startup sources could not be checked. Your message was not delivered.'

// Match the pinned stock 0.162.1 loader's local managed sources. Presence is
// sufficient to refuse: never parse policy contents or read account credentials.
const managedFiles = ['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml']
const managedPreferences = `ObjC.import('CoreFoundation');
ObjC.bindFunction('CFPreferencesAppSynchronize', ['bool', ['id']]);
if (!$.CFPreferencesAppSynchronize($('com.openai.codex'))) throw Error('Preference refresh failed');
ObjC.bindFunction('CFPreferencesAppValueIsForced', ['bool', ['id', 'id']]);
JSON.stringify(['config_toml_base64', 'requirements_toml_base64'].some(function (key) {
  return $.CFPreferencesAppValueIsForced($(key), $('com.openai.codex'));
}))`

function refuseManagedFiles(): void {
  for (const path of managedFiles) {
    try { lstatSync(path) }
    catch (error) {
      // A dangling symlink still counts as present; permission and IO errors do
      // not establish absence. lstat avoids following a policy-file symlink.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(UNKNOWN)
    }
    throw new Error(MANAGED)
  }
}

/**
 * Refuse known local managed sources BEFORE invoking Codex, including helpers.
 * A forced preference is unavailable even when empty/malformed. Query only its
 * forced status through the same CoreFoundation API as stock, not plist paths.
 * This is a point-in-time local check, not cloud-policy or source-race isolation.
 */
export async function codexStartupPreflight(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error(UNKNOWN)
  // Debug/runtime loader switches are not part of Cockpit's supported boundary.
  for (const name of ['CODEX_APP_SERVER_MANAGED_CONFIG_PATH', 'CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG', 'CODEX_APP_SERVER_TEST_USER_CONFIG_FILE']) {
    if (env[name] !== undefined) throw new Error(UNKNOWN)
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(UNKNOWN)
  refuseManagedFiles()
  if (process.platform !== 'darwin') return
  const output = await new Promise<string>((resolve, reject) => {
    let failed = true, output = ''
    // Abort can report its error before the process closes. Keep ownership until
    // close, including on timeout/abort; Quit must not leave the check running.
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', managedPreferences], {
      encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024, signal,
    }, (error, stdout) => { failed = error !== null; output = stdout })
    child.once('close', () => failed ? reject(new Error(UNKNOWN)) : resolve(output))
  })
  if (signal?.aborted) throw new Error(UNKNOWN)
  const status = output.trim()
  if (status === 'true') throw new Error(MANAGED)
  if (status !== 'false') throw new Error(UNKNOWN)
  // The preference query yielded. Detect a local policy added while it ran.
  refuseManagedFiles()
}
