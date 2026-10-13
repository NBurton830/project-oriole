import http from 'node:http';

/** Minimal Prometheus-style counters. */
const counters = new Map<string, number>([
  ['matrix_e2ee_key_timeout_count', 0],
  ['inference_failure_count', 0],
  ['inference_circuit_open_count', 0],
  ['turn_gating_silence_count', 0],
]);

export function increment(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function serveMetrics(port: number) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics') return void res.writeHead(404).end();
    const body = [...counters].map(([k, v]) => `# TYPE ${k} counter\n${k} ${v}`).join('\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
