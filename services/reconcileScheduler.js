// services/reconcileScheduler.js
const { reconcileOnce } = require('../services/paymentRetry');

const INTERVAL_MIN = Number(process.env.RECONCILE_INTERVAL_MIN || 10);
const LIMIT = Number(process.env.RECONCILE_SCHEDULE_LIMIT || 200);

let running = false;

async function runOnce() {
  if (running) {
    console.log('[reconcileScheduler] Already running. Skipping.');
    return;
  }

  running = true;
  try {
    console.log('[reconcileScheduler] Starting reconciliation');

    const result = await reconcileOnce({
      limit: LIMIT,
      runBy: 'scheduler:auto',
      dryRun: false
    });

    console.log('[reconcileScheduler] Finished', result);
  } catch (err) {
    console.error('[reconcileScheduler] ERROR', err);
  } finally {
    running = false;
  }
}

if (INTERVAL_MIN > 0) {
  console.log(`[reconcileScheduler] Auto-reconciliation enabled. Interval = ${INTERVAL_MIN} minutes.`);
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, INTERVAL_MIN * 60 * 1000);
  }, 30_000);
}

module.exports = { runOnce };
