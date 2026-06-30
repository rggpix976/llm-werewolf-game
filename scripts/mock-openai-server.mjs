import { createWebServer } from "../src/webServer.mjs";

const mockFetch = async (url, options) => {
    console.log("MOCK FETCH CALLED", url);
    return {
        ok: true,
        status: 200,
        headers: new Map([["x-request-id", "req_mock_browser"]]),
        json: async () => ({
            id: "resp_mock_browser",
            status: "completed",
            output: [{
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "私は人狼ではありません。信じてください。" }]
            }],
            usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 }
        })
    };
};

const config = {
    provider: "openai",
    openai: {
        apiKey: "mock-key",
        model: "gpt-mock",
        timeoutMs: 15000,
        maxRetries: 1,
        maxOutputTokens: 220,
        maxRequestsPerMinute: 60,
        fallbackToPseudo: true,
        fetch: mockFetch
    }
};

const server = createWebServer({ config });
server.listen(4174, "127.0.0.1", () => {
    console.log("Mock OpenAI Server running at http://127.0.0.1:4174/");
});
