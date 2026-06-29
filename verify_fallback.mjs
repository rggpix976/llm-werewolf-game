import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import http from 'http';

test('OpenAI fallback to pseudo in browser', async ({ page }) => {
  // Start mock server that returns 500
  const mockServer = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: "Mock Server Error" } }));
  });
  mockServer.listen(0, '127.0.0.1', async () => {
    const mockPort = mockServer.address().port;
    const mockUrl = \`http://127.0.0.1:\${mockPort}/v1/responses\`;

    // Start web server with fallback enabled
    const env = {
      ...process.env,
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_FALLBACK_TO_PSEUDO: 'true',
      OPENAI_API_URL: mockUrl,
      PORT: '3002'
    };
    const webServer = spawn('node', ['src/webServer.mjs'], { env });

    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await page.goto('http://127.0.0.1:3002');
      await page.click('#developerModeToggle');
      await page.fill('#playerQuestionInput', 'Fallback test?');
      await page.click('#askButton');

      // Wait for response - it should be from pseudo provider
      await page.waitForSelector('.log-entry');
      const logText = await page.innerText('.log-container');
      console.log('Log contains:', logText);

      // Check diagnostics
      const providerName = await page.innerText('[data-diagnostic-id="providerName"]');
      console.log('Actual providerName after fallback:', providerName);

      // If fallback worked, providerName should be 'pseudo' but diagnostics should show it came from openai
      expect(providerName).toBe('pseudo');

      await page.screenshot({ path: 'fallback_verification.png', fullPage: true });
    } finally {
      webServer.kill();
      mockServer.close();
    }
  });
});
