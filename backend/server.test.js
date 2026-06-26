import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from './server.js';

describe('Pulse Backend Server', () => {
  let app;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    app = createApp();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });

  describe('GET /health', () => {
    test('returns 200 and ok status', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('POST /api/turn (Anthropic)', () => {
    test('accepts valid request payload', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        json: jest.fn().mockResolvedValue({ id: 'msg_123', content: [] }),
      });

      const payload = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const res = await request(app)
        .post('/api/turn')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'msg_123', content: [] });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'test-api-key',
            'anthropic-version': '2023-06-01',
          }),
        })
      );
    });

    test('returns error response from upstream API', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 401,
        json: jest.fn().mockResolvedValue({ error: 'Invalid API key' }),
      });

      const payload = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const res = await request(app)
        .post('/api/turn')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid API key' });
    });

    test('handles network errors gracefully', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network timeout'));

      const payload = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const res = await request(app)
        .post('/api/turn')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Network timeout' });
    });

    test('rejects payloads larger than 4mb', async () => {
      const largePayload = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: 'x'.repeat(5 * 1024 * 1024),
          },
        ],
      };

      const res = await request(app)
        .post('/api/turn')
        .send(largePayload);

      expect(res.status).toBe(413);
    });

    test('sets correct Content-Type header', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        json: jest.fn().mockResolvedValue({ id: 'msg_123' }),
      });

      await request(app)
        .post('/api/turn')
        .send({ model: 'claude-3-opus-20240229', messages: [] });

      const callArgs = global.fetch.mock.calls[0][1];
      expect(callArgs.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('POST /api/turn (vLLM)', () => {
    beforeEach(() => {
      process.env.LLM_PROVIDER = 'vllm';
      process.env.LLM_BASE_URL = 'http://localhost:8000';
      process.env.LLM_MODEL = 'meta-llama/Llama-3.2-3B-Instruct';
      delete process.env.ANTHROPIC_API_KEY;
      app = createApp();
    });

    test('translates request to OpenAI format and normalizes response to Anthropic format', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-abc',
          model: 'meta-llama/Llama-3.2-3B-Instruct',
          choices: [{ message: { role: 'assistant', content: 'Hello from vLLM' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      const res = await request(app)
        .post('/api/turn')
        .send({
          model: 'claude-sonnet-4-6',
          max_tokens: 1600,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.content).toEqual([{ type: 'text', text: 'Hello from vLLM' }]);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('returns 500 with helpful message when vLLM is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app)
        .post('/api/turn')
        .send({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/vllm/i);
      expect(res.body.error).toMatch(/ECONNREFUSED/);
    });

    test('injects system message when body.system is present', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-xyz',
          model: 'meta-llama/Llama-3.2-3B-Instruct',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
      });

      await request(app)
        .post('/api/turn')
        .send({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Hi' }],
        });

      const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(sentBody.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(sentBody.messages[1]).toEqual({ role: 'user', content: 'Hi' });
    });
  });

  describe('CORS', () => {
    test('includes CORS headers in responses', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:5173');

      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });
});
