import workerThreads from "node:worker_threads";

if (typeof Reflect.get(workerThreads, "markAsUncloneable") !== "function") {
	Object.defineProperty(workerThreads, "markAsUncloneable", {
		configurable: true,
		enumerable: true,
		value: (_value: unknown): void => {},
		writable: true,
	});
}
