import type { GeminiClient } from '../../gemini/index.js';

/**
 * A Gemini client that announces every request before it is sent. Requests are the scarce quota (a free key allows a few
 * hundred a day), and the OCR worker makes more of them than the pages it is given suggest: a batch of eight pages is one
 * request, but a batch the model answers wrongly is asked for again page by page, a retry is a request too, and a big
 * rendering is split. The announcements are what the host counts and what the daily OCR budget is reconciled with.
 */
export function countingClient(client: GeminiClient, onRequest: () => void): GeminiClient {
  return {
    models: {
      generateContent: (...args: Parameters<GeminiClient['models']['generateContent']>) => {
        onRequest();
        return client.models.generateContent(...args);
      },
    },
  };
}
