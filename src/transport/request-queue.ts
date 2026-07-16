export interface DisposableLike {
	dispose(): void;
}

export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): DisposableLike;
}

export interface ChatRequestSlotLease {
	readonly waitMs: number;
	release(): void;
}

export type SerialRequestQueueEvent =
	| {
		  type: "wait";
		  requestId: string;
		  activeRequests: number;
		  queueLength: number;
		  queueTimeoutMs: number;
	  }
	| {
		  type: "acquired";
		  requestId: string;
		  waitMs: number;
		  queueLength: number;
	  }
	| {
		  type: "released";
		  requestId: string;
		  queueLength: number;
	  };

interface QueueWaiter {
	requestId: string;
	queuedAt: number;
	settled: boolean;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	cancellationSubscription?: DisposableLike;
	resolve: (lease: ChatRequestSlotLease) => void;
	reject: (error: Error) => void;
}

export class SerialRequestQueue {
	private activeRequestId: string | undefined;
	private readonly waiters: QueueWaiter[] = [];

	constructor(private readonly onEvent?: (event: SerialRequestQueueEvent) => void) {}

	acquire(
		requestId: string,
		queueTimeoutMs: number,
		token: CancellationTokenLike,
		createCancellationError: () => Error
	): Promise<ChatRequestSlotLease> {
		if (token.isCancellationRequested) {
			return Promise.reject(createCancellationError());
		}

		if (this.activeRequestId === undefined) {
			return Promise.resolve(this.createLease(requestId, 0));
		}

		const queuedAt = Date.now();
		this.onEvent?.({
			type: "wait",
			requestId,
			activeRequests: 1,
			queueLength: this.waiters.length + 1,
			queueTimeoutMs,
		});

		return new Promise<ChatRequestSlotLease>((resolve, reject) => {
			const waiter: QueueWaiter = {
				requestId,
				queuedAt,
				settled: false,
				resolve,
				reject,
			};

			const rejectWaiter = (error: Error): void => {
				if (waiter.settled) {
					return;
				}
				waiter.settled = true;
				this.removeWaiter(waiter);
				this.cleanupWaiter(waiter);
				waiter.reject(error);
			};

			this.waiters.push(waiter);
			waiter.cancellationSubscription = token.onCancellationRequested(() => {
				rejectWaiter(createCancellationError());
			});

			if (queueTimeoutMs > 0) {
				waiter.timeoutHandle = setTimeout(() => {
					rejectWaiter(new Error(`Timed out waiting ${queueTimeoutMs}ms for local llama.cpp request slot`));
				}, queueTimeoutMs);
			}

			if (token.isCancellationRequested) {
				rejectWaiter(createCancellationError());
			}
		});
	}

	private createLease(requestId: string, waitMs: number): ChatRequestSlotLease {
		this.activeRequestId = requestId;
		let released = false;

		this.onEvent?.({
			type: "acquired",
			requestId,
			waitMs,
			queueLength: this.waiters.length,
		});

		return {
			waitMs,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.release(requestId);
			},
		};
	}

	private release(requestId: string): void {
		if (this.activeRequestId !== requestId) {
			return;
		}

		this.activeRequestId = undefined;
		this.onEvent?.({
			type: "released",
			requestId,
			queueLength: this.waiters.length,
		});
		this.drain();
	}

	private drain(): void {
		if (this.activeRequestId !== undefined) {
			return;
		}

		const waiter = this.waiters.shift();
		if (!waiter || waiter.settled) {
			if (waiter) {
				this.drain();
			}
			return;
		}

		waiter.settled = true;
		this.cleanupWaiter(waiter);
		const lease = this.createLease(waiter.requestId, Date.now() - waiter.queuedAt);
		waiter.resolve(lease);
	}

	private removeWaiter(waiter: QueueWaiter): void {
		const index = this.waiters.indexOf(waiter);
		if (index !== -1) {
			this.waiters.splice(index, 1);
		}
	}

	private cleanupWaiter(waiter: QueueWaiter): void {
		if (waiter.timeoutHandle) {
			clearTimeout(waiter.timeoutHandle);
			waiter.timeoutHandle = undefined;
		}
		waiter.cancellationSubscription?.dispose();
		waiter.cancellationSubscription = undefined;
	}
}
