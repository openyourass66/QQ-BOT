import { acquireDataResources } from '../../dist/core/resource-lock.js';

process.once('message', async ({ resources }) => {
  try {
    const lease = await acquireDataResources(resources);
    process.once('disconnect', () => lease.release());
    process.on('message', message => {
      if (message === 'release') { lease.release(); process.disconnect(); }
    });
    process.send({ type: 'locked' });
  } catch (error) {
    process.exitCode = 73;
    process.send({ type: 'failed', code: error.code, error: error.message }, () => process.disconnect());
  }
});
