/**
 * Daemon lifecycle management — PID file read/write/clear, start/stop.
 *
 * The PID file at ~/.subspace/daemon.pid tracks the running daemon process.
 * It contains JSON: { pid, port, startedAt }.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { PID_PATH } from './config.js'

// Re-export for external callers that need the default path
export { PID_PATH }

export interface PidEntry {
  pid: number
  port: number
  startedAt: number
}

// ---------------------------------------------------------------------------
// PID file operations
// ---------------------------------------------------------------------------

export function writePid(port: number, pidPath: string = PID_PATH): void {
  const entry: PidEntry = {
    pid: process.pid,
    port,
    startedAt: Date.now(),
  }
  writeFileSync(pidPath, JSON.stringify(entry), 'utf8')
}

export function readPid(pidPath: string = PID_PATH): PidEntry | null {
  try {
    if (!existsSync(pidPath)) return null
    const raw = readFileSync(pidPath, 'utf8')
    return JSON.parse(raw) as PidEntry
  } catch {
    return null
  }
}

export function clearPid(pidPath: string = PID_PATH): void {
  try {
    unlinkSync(pidPath)
  } catch {
    // Ignore if already gone
  }
}

// ---------------------------------------------------------------------------
// Process health checks
// ---------------------------------------------------------------------------

/**
 * Returns true if a daemon process is currently running (PID file exists and process is alive).
 * @param pidPath Path to the PID file (defaults to global ~/.subspace/daemon.pid)
 */
export function isDaemonRunning(pidPath: string = PID_PATH): boolean {
  const entry = readPid(pidPath)
  if (!entry) return false
  try {
    // Signal 0 checks process existence without sending a real signal
    process.kill(entry.pid, 0)
    return true
  } catch {
    // Process not found — stale PID file
    clearPid(pidPath)
    return false
  }
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

/**
 * Start the daemon process.
 * - foreground: run inline (for Docker/CI). Does NOT return until daemon exits.
 * - background: spawn detached child process, unref, return immediately.
 */
export async function startDaemonProcess(foreground: boolean, port: number): Promise<void> {
  const daemonEntry = new URL('../../dist/index.js', import.meta.url)
  const daemonPath = fileURLToPath(daemonEntry)

  const args = [`--port`, String(port)]
  if (foreground) {
    args.push('--foreground')
  }

  if (foreground) {
    // In foreground mode the current process IS the daemon
    // The daemon entrypoint handles this directly — nothing to do here
    return
  }

  // Background: spawn detached, let it run independently
  const child = spawn(process.execPath, [daemonPath, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

/**
 * Stop the running daemon by sending SIGTERM to the PID from the PID file.
 * Returns true if the signal was sent, false if no daemon was running.
 * @param pidPath Path to the PID file (defaults to global ~/.subspace/daemon.pid)
 */
export function stopDaemon(pidPath: string = PID_PATH): boolean {
  const entry = readPid(pidPath)
  if (!entry) return false
  try {
    process.kill(entry.pid, 'SIGTERM')
    return true
  } catch {
    clearPid(pidPath)
    return false
  }
}
