import { Agent } from './agent.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { serveMetrics } from './metrics.ts';

const configPath = process.argv[2] ?? process.env.SYNAPSE_CONFIG ?? '/etc/synapse/config.yaml';
const config = loadConfig(configPath);

if (config.telemetry?.metrics_port) serveMetrics(config.telemetry.metrics_port);

const agent = new Agent(config);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('received %s, shutting down', signal);
    agent.stop();
    process.exit(0);
  });
}

agent.start().catch((err) => {
  log.error('startup failed: %s', err?.stack ?? err);
  process.exit(1);
});
