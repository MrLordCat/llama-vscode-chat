import * as assert from "assert";
import * as vscode from "vscode";
import { SerialRequestQueue, type SerialRequestQueueEvent } from "../transport/request-queue";

const cancellationError = (): Error => new vscode.CancellationError();

suite("serial request queue", () => {
	test("grants request slots in FIFO order", async () => {
		const events: SerialRequestQueueEvent[] = [];
		const queue = new SerialRequestQueue(event => events.push(event));
		const token = new vscode.CancellationTokenSource().token;
		const first = await queue.acquire("first", 0, token, cancellationError);
		const order: string[] = [];
		const secondPromise = queue.acquire("second", 0, token, cancellationError).then(lease => {
			order.push("second");
			return lease;
		});
		const thirdPromise = queue.acquire("third", 0, token, cancellationError).then(lease => {
			order.push("third");
			return lease;
		});

		first.release();
		const second = await secondPromise;
		assert.deepStrictEqual(order, ["second"]);
		second.release();
		const third = await thirdPromise;
		assert.deepStrictEqual(order, ["second", "third"]);
		third.release();

		assert.deepStrictEqual(
			events.filter(event => event.type === "acquired").map(event => event.requestId),
			["first", "second", "third"]
		);
	});

	test("removes a cancelled waiter without blocking the next request", async () => {
		const queue = new SerialRequestQueue();
		const activeToken = new vscode.CancellationTokenSource().token;
		const cancelledSource = new vscode.CancellationTokenSource();
		const first = await queue.acquire("first", 0, activeToken, cancellationError);
		const cancelled = queue.acquire("cancelled", 0, cancelledSource.token, cancellationError);
		const thirdPromise = queue.acquire("third", 0, activeToken, cancellationError);

		cancelledSource.cancel();
		await assert.rejects(cancelled, error => error instanceof vscode.CancellationError);
		first.release();
		const third = await thirdPromise;
		third.release();
	});

	test("times out a waiter and keeps the queue usable", async () => {
		const queue = new SerialRequestQueue();
		const token = new vscode.CancellationTokenSource().token;
		const first = await queue.acquire("first", 0, token, cancellationError);
		const timedOut = queue.acquire("timed-out", 5, token, cancellationError);

		await assert.rejects(timedOut, /Timed out waiting 5ms/);
		first.release();
		const next = await queue.acquire("next", 0, token, cancellationError);
		next.release();
	});

	test("release is idempotent", async () => {
		const events: SerialRequestQueueEvent[] = [];
		const queue = new SerialRequestQueue(event => events.push(event));
		const token = new vscode.CancellationTokenSource().token;
		const lease = await queue.acquire("only", 0, token, cancellationError);

		lease.release();
		lease.release();

		assert.strictEqual(events.filter(event => event.type === "released").length, 1);
	});
});
