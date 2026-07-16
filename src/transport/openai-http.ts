export interface RequestCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function isDeepSeekEndpoint(serverUrl: string): boolean {
	try {
		return new URL(serverUrl).hostname.toLowerCase().endsWith("deepseek.com");
	} catch {
		return false;
	}
}

export function getChatCompletionsEndpoint(serverUrl: string): string {
	return isDeepSeekEndpoint(serverUrl)
		? `${serverUrl}/chat/completions`
		: `${serverUrl}/v1/chat/completions`;
}

export function getModelsEndpoint(serverUrl: string): string {
	return isDeepSeekEndpoint(serverUrl)
		? `${serverUrl}/models`
		: `${serverUrl}/v1/models`;
}

export class OpenAIHttpTransport {
	constructor(private readonly fetchImplementation?: FetchImplementation) {}

	async request(
		url: string,
		init: RequestInit,
		timeoutMs: number,
		cancellation?: RequestCancellation
	): Promise<Response> {
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
		const cancellationSubscription = cancellation?.onCancellationRequested(() => controller.abort());

		if (cancellation?.isCancellationRequested) {
			controller.abort();
		}

		try {
			const fetchRequest = this.fetchImplementation ?? fetch;
			return await fetchRequest(url, {
				...init,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeoutHandle);
			cancellationSubscription?.dispose();
		}
	}

	postChatCompletion(
		serverUrl: string,
		headers: Record<string, string>,
		requestBody: Record<string, unknown>,
		timeoutMs: number,
		cancellation: RequestCancellation
	): Promise<Response> {
		return this.request(
			getChatCompletionsEndpoint(serverUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			},
			timeoutMs,
			cancellation
		);
	}
}
