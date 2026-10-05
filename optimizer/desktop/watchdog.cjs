// Start the optimizer again if it has stopped.
//
// Closing the window never stopped the work and "Start with Windows" covers a
// reboot, but neither covers the case in between: the process is gone — killed,
// crashed, or taken down with something else — and the machine stays up for
// days with nothing running. That happened on the owner's box: a stale lock left
// the optimizer refusing to start and it sat idle for two days before anyone
// noticed.
//
// A Scheduled Task rather than a second process, because a watchdog process is
// just another thing that can die, and then you need a watchdog for the
// watchdog. Windows already owns a supervisor that survives reboots and runs
// nothing while it is idle.
//
// WHY IT CAN LAUNCH A RUNNING APP SAFELY. The task fires every few minutes
// regardless. The app holds a single-instance lock, so a second copy never
// starts work — but the default behaviour on a second instance is to SHOW THE
// WINDOW, which would raise it in the owner's face every five minutes for ever.
// Hence WATCHDOG_FLAG: an instance started by the task is recognised and
// ignored. The flag earns its keep in that one line.
const { execFileSync } = require('node:child_process');

const TASK_NAME = 'Marquee Optimizer watchdog';

// --hidden so a relaunch does not raise a window; --watchdog so a relaunch that
// finds the app already running is silent instead of showing it.
const WATCHDOG_FLAG = '--watchdog';
const HIDDEN_FLAG = '--hidden';

/** What the Scheduled Task runs. Quoted for schtasks, which re-parses it. */
function taskCommand(exePath) {
  return `"${exePath}" ${HIDDEN_FLAG} ${WATCHDOG_FLAG}`;
}

/**
 * The schtasks arguments to create it.
 *
 * No /RU and no /RL HIGHEST deliberately: the task runs as the logged-on owner,
 * in their session, with no elevation. A tray application needs a desktop to
 * live on, and asking for administrator to enable a convenience would be the
 * wrong trade.
 */
function createArgs(exePath, everyMinutes = 5) {
  return [
    '/Create', '/TN', TASK_NAME,
    '/TR', taskCommand(exePath),
    '/SC', 'MINUTE', '/MO', String(everyMinutes),
    '/F'
  ];
}

const run = (args) => {
  execFileSync('schtasks', args, { windowsHide: true, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
};

/** Is the task registered? */
function isEnabled() {
  try {
    run(['/Query', '/TN', TASK_NAME]);
    return true;
  } catch { return false; }   // schtasks exits non-zero when it does not exist
}

/** Register it. Throws with schtasks' own message so the caller can show it. */
function enable(exePath, everyMinutes = 5) {
  run(createArgs(exePath, everyMinutes));
}

/** Remove it. Succeeds quietly if it was not there. */
function disable() {
  try { run(['/Delete', '/TN', TASK_NAME, '/F']); } catch { /* already gone */ }
}

/**
 * Was this process started by the watchdog?
 *
 * Checked against an explicit argv so it can be tested, and because
 * process.argv differs between a packaged app and `electron .`.
 */
function startedByWatchdog(argv = process.argv) {
  return argv.includes(WATCHDOG_FLAG);
}

module.exports = {
  TASK_NAME, WATCHDOG_FLAG, HIDDEN_FLAG,
  taskCommand, createArgs, isEnabled, enable, disable, startedByWatchdog
};
