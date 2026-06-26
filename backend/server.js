import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { callProvider } from './providers.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));

  app.post('/api/turn', async (req, res) => {
    try {
      const { status, body } = await callProvider(req.body);
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/health', (_, res) => res.json({ ok: true }));

  return app;
}

// Only run startup validation and listen when executed directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();

  if (provider === 'vllm') {
    const baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:8000';
    console.log(`Pulse backend: provider=vllm, baseUrl=${baseUrl}, model=${process.env.LLM_MODEL ?? '(from request)'}`);
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY env var is required when LLM_PROVIDER is not vllm');
      process.exit(1);
    }
    console.log('Pulse backend: provider=anthropic');
  }

  const app = createApp();
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Pulse backend listening on :${PORT}`));
}
