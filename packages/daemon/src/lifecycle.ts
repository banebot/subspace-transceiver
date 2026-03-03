/**
 * Daemon lifecycle management — PID file read/write/clear, start/stop.
 *
 * The PID file at ~/.agent-net/daemon.pid tracks the running daemon process.
 * It contains JSON: { pid, port, startedAt }.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { PID_PATH } from './config.js'

export interface PidEntry {
  pid: number
  port: number
  startedAt: number
}

// ---------------------------------------------------------------------------
// PID file operations
// ---------------------------------------------------------------------------

export function writePid(port: number): void {
  const entry: PidEntry = {
    pid: process.pid,
    port,
    startedAt: Date.now(),
  }
  writeFileSync(PID_PATH, JSON.stringify(entry), 'utf8')
}

export function readPid(): PidEntry | null {
  try {
    if (!existsSync(PID_PATH)) return null
    const raw = readFileSync(PID_PATH, 'utf8')
    return JSON.parse(raw) as PidEntry
  } catch {
    return null
  }
}

export function clearPid(): void {
  try {
    unlinkSync(PID_PATH)
  } catch {
    // Ignore if already gone
  }
}

// ---------------------------------------------------------------------------
// Process health checks
// ---------------------------------------------------------------------------

/**
 * Returns true if a daemon process is currently running (PID file exists and process is alive).
 */
export function isDaemonRunning(): boolean {
  const entry = readPid()
  if (!entry) return false
  try {
    // Signal 0 checks process existence without sending a real signal
    process.kill(entry.pid, 0)
    return true
  } catch {
    // Process not found — stale PID file
    clearPid()
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
 */
export function stopDaemon(): boolean {
  const entry = readPid()
  if (!entry) return false
  try {
    process.kill(entry.pid, 'SIGTERM')
    return true
  } catch {
    clearPid()
    return false
  }
}
