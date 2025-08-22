import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as gitSourceProvider from './git-source-provider'
import * as inputHelper from './input-helper'
import * as path from 'path'
import * as stateHelper from './state-helper'
import {spawn} from 'child_process'
import * as io from '@actions/io'

async function performMain(): Promise<void> {
  try {
    const sourceSettings = await inputHelper.getInputs()

    try {
      // Register problem matcher
      coreCommand.issueCommand(
        'add-matcher',
        {},
        path.join(__dirname, 'problem-matcher.json')
      )

      // Get sources
      await gitSourceProvider.getSource(sourceSettings)
      core.setOutput('ref', sourceSettings.ref)
    } finally {
      // Unregister problem matcher
      coreCommand.issueCommand('remove-matcher', {owner: 'checkout-git'}, '')
    }
  } catch (error) {
    core.setFailed(`${(error as any)?.message ?? error}`)
  }
}

async function runWithTimeoutAndRetry(): Promise<void> {
  // Parse high-level inputs here to keep them out of IGitSourceSettings
  const timeoutInput = core.getInput('timeout') || '0'
  const retryInput = core.getInput('retry') || '0'

  let timeoutSeconds = Math.floor(Number(timeoutInput))
  let retryCount = Math.floor(Number(retryInput))

  if (!isFinite(timeoutSeconds) || timeoutSeconds < 0) timeoutSeconds = 0
  if (!isFinite(retryCount) || retryCount < 0) retryCount = 0

  // Child-mode executes the actual action logic so the parent can time out/kill and retry cleanly
  if (process.env['CHECKOUT_CHILD'] === '1') {
    await performMain()
    return
  }

  // Fast path if no timeout and no retry
  if (timeoutSeconds === 0 && retryCount === 0) {
    await performMain()
    return
  }

  const attempts = retryCount + 1
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptLabel = `Attempt ${attempt}/${attempts}`
    core.info(`Starting checkout ${attemptLabel}`)

    const result = await runChildOnce(timeoutSeconds)
    if (result.success) {
      return
    }

    lastError = result.error ?? new Error('Unknown error')
    const reason = result.timedOut ? 'timeout' : 'failure'
    core.warning(`Checkout ${attemptLabel} ended with ${reason}: ${lastError.message}`)

    // Ensure problem matcher is removed if the child exited unexpectedly
    try {
      coreCommand.issueCommand('remove-matcher', {owner: 'checkout-git'}, '')
    } catch {}

    // Clean up git state before a retry so the next attempt is from a clean slate
    try {
      await cleanupGitState()
    } catch (e) {
      core.warning(`Failed to cleanup git state: ${(e as any)?.message ?? e}`)
    }

    if (attempt < attempts) {
      core.info('Retrying...')
    }
  }

  core.setFailed(
    `Checkout failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`
  )
}

function runChildOnce(
  timeoutSeconds: number
): Promise<{success: boolean; timedOut: boolean; error?: Error}> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [process.argv[1]], {
      env: {...process.env, CHECKOUT_CHILD: '1'},
      stdio: 'inherit'
    })

    let timedOut = false
    let timeoutHandle: NodeJS.Timeout | undefined
    let hardKillHandle: NodeJS.Timeout | undefined

    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (hardKillHandle) clearTimeout(hardKillHandle)
    }

    if (timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        // Try graceful stop first
        child.kill('SIGTERM')
        // Ensure termination
        hardKillHandle = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }, 5000)
      }, timeoutSeconds * 1000)
    }

    child.on('error', err => {
      clearTimers()
      resolve({success: false, timedOut: false, error: err as Error})
    })

    child.on('exit', (code, signal) => {
      clearTimers()
      if (code === 0) {
        resolve({success: true, timedOut: false})
      } else {
        const msg = timedOut
          ? `Timed out after ${timeoutSeconds}s`
          : signal
            ? `Exited due to signal ${signal}`
            : `Exited with code ${code}`
        resolve({success: false, timedOut, error: new Error(msg)})
      }
    })
  })
}

async function cleanupGitState(): Promise<void> {
  // Determine repository path similar to input-helper, but without requiring token
  const githubWorkspacePath = process.env['GITHUB_WORKSPACE']
  if (!githubWorkspacePath) {
    return
  }
  const repoRelativePath = core.getInput('path') || '.'
  const repoPath = path.resolve(githubWorkspacePath, repoRelativePath)
  const gitDir = path.join(repoPath, '.git')

  core.startGroup('Cleaning up git state for retry')
  await io.rmRF(gitDir)
  core.info(`Removed '${gitDir}' if it existed`)
  core.endGroup()
}

async function cleanup(): Promise<void> {
  try {
    await gitSourceProvider.cleanup(stateHelper.RepositoryPath)
  } catch (error) {
    core.warning(`${(error as any)?.message ?? error}`)
  }
}

// Main
if (!stateHelper.IsPost) {
  runWithTimeoutAndRetry()
}
// Post
else {
  cleanup()
}
